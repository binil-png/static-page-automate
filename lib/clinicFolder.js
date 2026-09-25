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

function significantTokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !["clinic", "files", "the", "and", "for"].includes(token));
}

function escapeDriveQuery(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function folderMatchesClinic(name, needles, clinic = {}) {
  const normalized = normalizeMatch(name);
  if (needles.some((needle) => (
    (needle.length >= 4 && normalized.includes(needle))
    || (normalized.length >= 6 && needle.includes(normalized))
  ))) {
    return true;
  }

  const emailKey = normalizeMatch(String(clinic.email || "").split("@")[0]);
  if (emailKey.length >= 4 && normalized.includes(emailKey)) {
    return true;
  }

  const nameTokens = significantTokens(name);
  const clinicTokens = significantTokens(clinic.clinicName);
  const overlap = clinicTokens.filter((token) => nameTokens.includes(token) || normalized.includes(token));
  return overlap.length >= 2 || (overlap.length === 1 && overlap[0].length >= 5);
}

function collectClinicDriveIds(clinic) {
  const seen = new Set();
  const ids = [];
  const values = [];
  for (const [key, value] of Object.entries(clinic || {})) {
    if (key !== "extraFields" && typeof value === "string") {
      values.push(value);
    }
  }
  values.push(...Object.values(clinic.extraFields || {}));

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

async function listFoldersByQuery(drive, q) {
  const files = [];
  let pageToken;

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

async function listCandidateFolders(drive, parentFolderId, clinic = {}) {
  const seen = new Set();
  const files = [];

  const add = (items) => {
    for (const item of items) {
      if (!item?.id || seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      files.push(item);
    }
  };

  if (parentFolderId) {
    add(await listFoldersByQuery(
      drive,
      `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    ));
  }

  const terms = [];
  if (clinic.clinicName) {
    terms.push(String(clinic.clinicName).trim().split(/\s+/).slice(0, 3).join(" "));
  }
  if (clinic.email) {
    terms.push(clinic.email);
    terms.push(String(clinic.email).split("@")[0]);
  }
  terms.push("Clinic files");

  for (const term of [...new Set(terms.filter((value) => String(value || "").trim().length >= 3))]) {
    try {
      add(await listFoldersByQuery(
        drive,
        `mimeType = 'application/vnd.google-apps.folder' and trashed = false and name contains '${escapeDriveQuery(term)}'`
      ));
    } catch (error) {
      console.warn(`Drive folder name search skipped for "${term}": ${error.message}`);
    }
  }

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
    const folders = await listCandidateFolders(drive, settings.parentFolderId, clinic);
    const match = folders
      .filter((folder) => folderMatchesClinic(folder.name, needles, clinic))
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
