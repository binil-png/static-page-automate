import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SETUP_FILE = path.join(process.cwd(), "setup.json");

export function parseSheetInput(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return { sheetId: "", gid: "" };
  }

  const idMatch = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = value.match(/[?#&]gid=([0-9]+)/);

  return {
    sheetId: idMatch ? idMatch[1] : value,
    gid: gidMatch ? gidMatch[1] : ""
  };
}

export async function loadSetupConfig() {
  try {
    return JSON.parse(await readFile(SETUP_FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function saveSetupConfig(nextValues) {
  const current = await loadSetupConfig();
  const parsed = parseSheetInput(nextValues.sheetUrl || nextValues.sheetId || "");
  const config = {
    sheetUrl: String(nextValues.sheetUrl || current.sheetUrl || "").trim(),
    sheetId: parsed.sheetId || String(nextValues.sheetId || current.sheetId || "").trim(),
    tab: String(nextValues.tab ?? current.tab ?? "").trim(),
    gid: String(nextValues.gid || parsed.gid || current.gid || "").trim(),
    formUrl: String(nextValues.formUrl ?? current.formUrl ?? "").trim(),
    parentFolderId: String(nextValues.parentFolderId ?? current.parentFolderId ?? "").trim(),
    anthropicApiKey: current.anthropicApiKey || ""
  };

  if (Object.prototype.hasOwnProperty.call(nextValues, "anthropicApiKey")) {
    const key = String(nextValues.anthropicApiKey || "").trim();
    if (key) {
      config.anthropicApiKey = key;
    }
  }

  await writeFile(SETUP_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export async function getSheetSettings() {
  const setup = await loadSetupConfig();
  const fromEnv = parseSheetInput(process.env.GOOGLE_SHEET_URL || process.env.GOOGLE_SHEET_ID || "");

  return {
    sheetUrl: setup.sheetUrl || process.env.GOOGLE_SHEET_URL || "",
    sheetId: setup.sheetId || fromEnv.sheetId,
    tab: setup.tab || process.env.GOOGLE_SHEET_TAB || "",
    gid: setup.gid || process.env.GOOGLE_SHEET_GID || fromEnv.gid
  };
}

export function parseFormInput(raw) {
  const value = String(raw || "").trim();
  const fileIdMatch = value.match(/\/forms\/d\/(?!e\/)([a-zA-Z0-9-_]+)/);
  const publishedMatch = value.match(/\/forms\/d\/e\/([a-zA-Z0-9-_]+)/);

  return {
    formUrl: value,
    formFileId: fileIdMatch ? fileIdMatch[1] : "",
    formViewUrl: publishedMatch
      ? `https://docs.google.com/forms/d/e/${publishedMatch[1]}/viewform`
      : (fileIdMatch ? `https://docs.google.com/forms/d/${fileIdMatch[1]}/viewform` : value)
  };
}

export async function getAnthropicApiKey() {
  const setup = await loadSetupConfig();
  return String(process.env.ANTHROPIC_API_KEY || setup.anthropicApiKey || "").trim();
}

export async function getShareSettings() {
  const setup = await loadSetupConfig();
  const formUrl = setup.formUrl || process.env.GOOGLE_FORM_URL || "";
  const parsed = parseFormInput(formUrl);

  return {
    formUrl,
    formFileId: parsed.formFileId || process.env.GOOGLE_FORM_ID || "",
    formViewUrl: parsed.formViewUrl,
    parentFolderId: setup.parentFolderId || process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || ""
  };
}
