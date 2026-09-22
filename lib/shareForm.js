import nodemailer from "nodemailer";
import { getDriveClient } from "./googleAuth.js";
import { getShareSettings } from "./setupConfig.js";

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function driveError(error, fallback) {
  const status = error.code || error.status;
  if (status === 403 || status === 404) {
    return new Error("Cannot use Google Drive. Share the form and parent folder with the service account email, and enable the Drive API.");
  }
  return error.message ? error : new Error(fallback);
}

async function shareFile(drive, fileId, email, role) {
  await drive.permissions.create({
    fileId,
    sendNotificationEmail: false,
    supportsAllDrives: true,
    requestBody: {
      type: "user",
      role,
      emailAddress: email
    }
  });
}

async function createClientFolder(drive, email, parentFolderId) {
  const requestBody = {
    name: `Clinic files - ${email} - ${new Date().toISOString().slice(0, 10)}`,
    mimeType: "application/vnd.google-apps.folder"
  };

  if (parentFolderId) {
    requestBody.parents = [parentFolderId];
  }

  const created = await drive.files.create({
    requestBody,
    fields: "id, webViewLink",
    supportsAllDrives: true
  });

  return created.data;
}

function buildEmail({ email, formLink, folderLink }) {
  const text = [
    "Please complete the clinic website form and upload your brand files.",
    "",
    `Form: ${formLink}`,
    `Google Drive folder: ${folderLink}`,
    "",
    "Upload logos and images to the Drive folder, then submit the form."
  ].join("\n");

  return {
    to: email,
    subject: "Clinic website form and upload folder",
    text,
    html: `<p>Please complete the clinic website form and upload your brand files.</p>
<p><a href="${formLink}">Open the form</a></p>
<p><a href="${folderLink}">Open the Google Drive folder</a></p>
<p>Upload logos and images to the Drive folder, then submit the form.</p>`
  };
}

async function sendEmail(message) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return { sent: false, reason: "SMTP is not configured. Folder and form were still shared with the client." };
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass }
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || user,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html
  });

  return { sent: true };
}

export async function shareFormWithClient(rawEmail) {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!isEmail(email)) {
    throw new Error("Enter a valid client Gmail address.");
  }

  const settings = await getShareSettings();
  if (!settings.formViewUrl && !settings.formFileId) {
    throw new Error("Set the Google Form URL in Sheet settings or GOOGLE_FORM_URL in .env.");
  }

  const drive = await getDriveClient();
  const formLink = settings.formViewUrl || `https://docs.google.com/forms/d/${settings.formFileId}/viewform`;

  try {
    const folder = await createClientFolder(drive, email, settings.parentFolderId);
    await shareFile(drive, folder.id, email, "writer");

    if (settings.formFileId) {
      try {
        await shareFile(drive, settings.formFileId, email, "reader");
      } catch (error) {
        console.warn(`Form file share skipped: ${error.message}`);
      }
    }

    const message = buildEmail({ email, formLink, folderLink: folder.webViewLink });
    const emailResult = await sendEmail(message);

    return {
      email,
      formLink,
      folderLink: folder.webViewLink,
      folderId: folder.id,
      emailSent: emailResult.sent,
      emailNote: emailResult.reason || ""
    };
  } catch (error) {
    throw driveError(error, "Failed to share the form and Drive folder.");
  }
}
