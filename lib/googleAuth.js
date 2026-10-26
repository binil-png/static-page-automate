import "./loadEnv.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive"
];

let authClient;

function normalizeServiceAccountKey(key) {
  if (!key || typeof key !== "object") {
    return null;
  }
  const privateKey = String(key.private_key || "").replace(/\\n/g, "\n");
  if (!key.client_email || !privateKey) {
    return null;
  }
  return {
    ...key,
    private_key: privateKey
  };
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(String(raw || "").trim());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function loadServiceAccountKey() {
  const fromBase64 = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || "").trim();
  if (fromBase64) {
    try {
      const decoded = Buffer.from(fromBase64, "base64").toString("utf8");
      const key = normalizeServiceAccountKey(parseJsonObject(decoded));
      if (key) {
        return key;
      }
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64 JSON.");
    }
  }

  const fromJson = normalizeServiceAccountKey(parseJsonObject(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ""));
  if (fromJson) {
    return fromJson;
  }

  try {
    const key = normalizeServiceAccountKey(JSON.parse(await readFile(getServiceAccountFilePath(), "utf8")));
    if (key) {
      return key;
    }
  } catch {
    // fall through to the shared error
  }

  throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON on Render, or upload a service account JSON key.");
}

export async function getGoogleAuth() {
  if (authClient) {
    return authClient;
  }

  const key = await loadServiceAccountKey();
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
  try {
    const key = await loadServiceAccountKey();
    return { hasCredentials: true, email: key.client_email || "" };
  } catch {
    return { hasCredentials: false, email: "" };
  }
}
