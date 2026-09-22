import { readFile } from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive"
];

let authClient;

export async function getGoogleAuth() {
  if (authClient) {
    return authClient;
  }

  const resolved = getServiceAccountFilePath();
  let key;

  try {
    key = JSON.parse(await readFile(resolved, "utf8"));
  } catch {
    throw new Error("Upload a service account JSON key or set GOOGLE_SERVICE_ACCOUNT_FILE in .env.");
  }

  if (!key.client_email || !key.private_key) {
    throw new Error("Service account JSON is missing client_email or private_key.");
  }

  authClient = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES
  });

  return authClient;
}

export async function getSheetsClient() {
  return google.sheets({ version: "v4", auth: await getGoogleAuth() });
}

export async function getDriveClient() {
  return google.drive({ version: "v3", auth: await getGoogleAuth() });
}

export function resetGoogleAuth() {
  authClient = null;
}

export function getServiceAccountFilePath() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "./credentials.json";
  return path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);
}

export async function getServiceAccountInfo() {
  const resolved = getServiceAccountFilePath();
  try {
    const key = JSON.parse(await readFile(resolved, "utf8"));
    if (!key.client_email) {
      return { hasCredentials: false, email: "" };
    }
    return { hasCredentials: true, email: key.client_email };
  } catch {
    return { hasCredentials: false, email: "" };
  }
}
