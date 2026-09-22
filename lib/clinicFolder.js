import { getDriveClient } from "./googleAuth.js";
import { getShareSettings } from "./setupConfig.js";

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalizeMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractUrls(value) {
  return [...String(value || "").matchAll(/https?:\/\/[^\s,"'<>]+/gi)].map((match) => match[0]);
}

function extractDriveId(url) {
  const folderMatch = String(url || "").match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) {
    return folderMatch[1];
  }

  const fileIdMatch = String(url || "").match(/\/d\/([a-zA-Z0-9_-]+)/) || String(url || "").match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fileIdMatch && /drive\.google\.com|docs\.google\.com/.test(url)) {
    return fileIdMatch[1];
  }

  return null;
}

function driveError(error, fallback) {
  const status = error.code || error.status;
  if (status === 403 || status === 404) {
    return new Error("Cannot use Google Drive. Share the parent folder with the service account email, and enable the Drive API.");
  }
  return error.message ? error : new Error(fallback);
}

function folderLink(id, webViewLink) {
  return webViewLink || `https://drive.google.com/drive/folders/${id}`;
}

function toFolderResult(folder, extra = {}) {
  return {
    exists: true,
    folderId: folder.id,
    folderName: folder.name || "Clinic files",
    folderLink: folderLink(folder.id, folder.webViewLink),
    ...extra
  };
}

function matchNeedles(clinic) {
  return [clinic.email, clinic.clinicName]
    .filter(Boolean)
    .map(normalizeMatch)
    .filter((value) => value.length >= 4);
}

function folderMatchesClinic(name, needles) {
  const normalized = normalizeMatch(name);
  return needles.some((needle) => normalized.includes(needle));
}

function collectClinicDriveIds(clinic) {
  const seen = new Set();
  const ids = [];
  const values = [clinic.filesLink, clinic.logo, ...Object.values(clinic.extraFields || {})];

  for (const value of values) {
    for (const url of extractUrls(value)) {
      const id = extractDriveId(url);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

  return ids;
}

async function getFolderMeta(drive, fileId) {
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, webViewLink, shortcutDetails",
    supportsAllDrives: true
  });
  const file = meta.data;

  if (file.mimeType === "application/vnd.google-apps.shortcut" && file.shortcutDetails?.targetId) {
    return getFolderMeta(drive, file.shortcutDetails.targetId);
  }

  if (file.mimeType !== "application/vnd.google-apps.folder") {
    return null;
  }

  return file;
}

async function listCandidateFolders(drive, parentFolderId) {
  const files = [];
  let pageToken;
  const q = parentFolderId
    ? `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    : "mimeType = 'application/vnd.google-apps.folder' and trashed = false and name contains 'Clinic files'";

  do {
    const result = await drive.files.list({
      q,
      fields: "nextPageToken, files(id, name, webViewLink, createdTime)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    files.push(...(result.data.files || []));
    pageToken = result.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function shareIfEmail(drive, folderId, email) {
  if (!isEmail(email)) {
    return;
  }

  try {
    await drive.permissions.create({
      fileId: folderId,
      sendNotificationEmail: false,
      supportsAllDrives: true,
      requestBody: {
        type: "user",
        role: "writer",
        emailAddress: String(email).trim().toLowerCase()
      }
    });
  } catch (error) {
    console.warn(`Clinic folder share skipped: ${error.message}`);
  }
}

export async function findClinicFolder(clinic) {
  const drive = await getDriveClient();
  const settings = await getShareSettings();

  for (const id of collectClinicDriveIds(clinic)) {
    try {
      const folder = await getFolderMeta(drive, id);
      if (folder) {
        return toFolderResult(folder, { created: false, source: "sheet" });
      }
    } catch {
      // Skip Drive IDs from the sheet that the service account cannot open.
    }
  }

  const needles = matchNeedles(clinic);
  if (!needles.length) {
    return { exists: false, created: false, folderId: "", folderName: "", folderLink: "" };
  }

  try {
    const folders = await listCandidateFolders(drive, settings.parentFolderId);
    const match = folders
      .filter((folder) => folderMatchesClinic(folder.name, needles))
      .sort((left, right) => String(right.createdTime || "").localeCompare(String(left.createdTime || "")))[0];

    if (match) {
      return toFolderResult(match, { created: false, source: "drive" });
    }
  } catch (error) {
    throw driveError(error, "Could not search Google Drive for a clinic folder.");
  }

  return { exists: false, created: false, folderId: "", folderName: "", folderLink: "" };
}

export async function createClinicFolder(clinic) {
  const drive = await getDriveClient();
  const settings = await getShareSettings();
  const date = new Date().toISOString().slice(0, 10);
  const name = clinic.email
    ? `Clinic files - ${clinic.clinicName} - ${clinic.email}`
    : `Clinic files - ${clinic.clinicName} - ${date}`;

  const requestBody = {
    name,
    mimeType: "application/vnd.google-apps.folder"
  };

  if (settings.parentFolderId) {
    requestBody.parents = [settings.parentFolderId];
  }

  try {
    const created = await drive.files.create({
      requestBody,
      fields: "id, name, webViewLink",
      supportsAllDrives: true
    });
    await shareIfEmail(drive, created.data.id, clinic.email);
    return toFolderResult(created.data, { created: true, source: "created" });
  } catch (error) {
    throw driveError(error, "Failed to create the Google Drive folder.");
  }
}
