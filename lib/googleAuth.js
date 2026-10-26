import "./loadEnv.js";
import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import { existingServiceAccountFile, getServiceAccountWritePath, serviceAccountReadPaths } from "./runtimePaths.js";

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

  for (const filePath of serviceAccountReadPaths()) {
    try {
      const key = normalizeServiceAccountKey(JSON.parse(await readFile(filePath, "utf8")));
      if (key) {
        return key;
      }
    } catch {
      // try the next candidate (env JSON, Render secret file, or local credentials.json)
    }
  }

  throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON on Render, add a Secret File at /etc/secrets/credentials.json, or upload a service account JSON key.");
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
  return existingServiceAccountFile() || getServiceAccountWritePath();
}

export async function getServiceAccountInfo() {
  try {
    const key = await loadServiceAccountKey();
    return { hasCredentials: true, email: key.client_email || "" };
  } catch {
    return { hasCredentials: false, email: "" };
  }
}
