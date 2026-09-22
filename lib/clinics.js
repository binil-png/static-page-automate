import { getSheetsClient } from "./googleAuth.js";
import { getSheetSettings } from "./setupConfig.js";

const CACHE_MS = 60_000;

let cache = { at: 0, clinics: null };

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function normalizeHeader(header) {
  return String(header || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "clinic";
}

function matchField(header) {
  const label = normalizeHeader(header);
  if (!label || label.includes("timestamp")) {
    return null;
  }
  if (label === "clinic name" || label.startsWith("clinic name") || label === "name") {
    return "clinicName";
  }
  if (label.includes("tag line") || label.includes("caption")) {
    return "tagline";
  }
  if (label.includes("uploaded files") || label.includes("file transfer") || label.includes("files link")) {
    return "filesLink";
  }
  if (label.includes("full address") || (label.includes("address") && label.includes("contact"))) {
    return "address";
  }
  if (label.includes("contact number")) {
    return "contactNumbers";
  }
  if (label.includes("email")) {
    return "email";
  }
  if (label.includes("customer support") || label.includes("enquiry")) {
    return "supportNumber";
  }
  if (label.includes("timing") || label.includes("working hours")) {
    return "timing";
  }
  if (label.includes("booking widget") || label.includes("online booking")) {
    return "bookingWidget";
  }
  if (label.includes("google map") || label.includes("map location")) {
    return "mapLocation";
  }
  if (label.includes("welcome")) {
    return "welcomeText";
  }
  if (label.includes("about")) {
    return "about";
  }
  if (label.includes("specialty") || label.includes("services")) {
    return "services";
  }
  if (label.includes("social")) {
    return "socialLinks";
  }
  if (label.includes("logo")) {
    return "logo";
  }
  if (label.includes("photo gallery") || label === "gallery") {
    return "photoGallery";
  }
  if (label.includes("extra pages") || label.includes("testimonial")) {
    return "extraPages";
  }
  if (label.includes("domain")) {
    return "domainSuggestions";
  }
  if (label.includes("terms")) {
    return "terms";
  }
  return null;
}

function rowToClinic(row, index) {
  const clinic = { extraFields: {} };

  for (const [header, raw] of Object.entries(row)) {
    const value = decodeHtml(raw);
    if (!value) {
      continue;
    }

    const field = matchField(header);
    if (field) {
      clinic[field] = value;
    } else if (!normalizeHeader(header).includes("timestamp")) {
      clinic.extraFields[header] = value;
    }
  }

  if (!clinic.clinicName) {
    return null;
  }

  clinic.id = `${slugify(clinic.clinicName)}-${index + 1}`;
  return clinic;
}

function rowsToObjects(rows) {
  const headers = rows[0] || [];
  return rows.slice(1).map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] || "";
    });
    return record;
  });
}

async function extractSheetRef() {
  const settings = await getSheetSettings();
  if (!settings.sheetId) {
    throw new Error("Connect a Google Sheet in the setup form, or set GOOGLE_SHEET_ID in .env.");
  }

  return {
    sheetId: settings.sheetId,
    gid: settings.gid || "",
    tab: settings.tab || ""
  };
}

function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function sheetApiError(error, fallback) {
  const status = error.code || error.status;
  if (status === 403 || status === 404) {
    return new Error("Cannot read the Google Sheet. Share it with the service account email as Viewer.");
  }
  return error.message ? error : new Error(fallback);
}

async function resolveTabTitle(sheets, spreadsheetId, { tab, gid }) {
  if (tab) {
    return tab;
  }

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)"
  });
  const tabs = meta.data.sheets || [];

  if (gid) {
    const match = tabs.find((sheet) => String(sheet.properties?.sheetId) === String(gid));
    if (!match?.properties?.title) {
      throw new Error(`No sheet tab found for gid=${gid}.`);
    }
    return match.properties.title;
  }

  if (!tabs[0]?.properties?.title) {
    throw new Error("Google Sheet has no tabs.");
  }

  return tabs[0].properties.title;
}

async function loadFromGoogleSheet() {
  const ref = await extractSheetRef();
  const sheets = await getSheetsClient();

  let title;
  try {
    title = await resolveTabTitle(sheets, ref.sheetId, ref);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ref.sheetId,
      range: quoteSheetTitle(title),
      majorDimension: "ROWS"
    });
    const rows = result.data.values || [];
    if (rows.length < 2) {
      throw new Error("Google Sheet has no clinic rows.");
    }
    return rowsToObjects(rows).map(rowToClinic).filter(Boolean);
  } catch (error) {
    throw sheetApiError(error, "Failed to read the Google Sheet with the service account.");
  }
}

async function loadClinics() {
  return loadFromGoogleSheet();
}

export function clearClinicCache() {
  cache = { at: 0, clinics: null };
}

export async function listClinics(forceRefresh = false) {
  if (!forceRefresh && cache.clinics && Date.now() - cache.at < CACHE_MS) {
    return cache.clinics;
  }

  const clinics = await loadClinics();
  cache = { at: Date.now(), clinics };
  return clinics;
}

export async function getClinicById(clinicId) {
  const clinics = await listClinics();
  return clinics.find((clinic) => clinic.id === clinicId) || null;
}

export function toClinicSummary(clinic) {
  return {
    id: clinic.id,
    clinicName: clinic.clinicName,
    tagline: clinic.tagline || "",
    address: clinic.address || "",
    email: clinic.email || "",
    timing: clinic.timing || "",
    contactNumbers: clinic.contactNumbers || clinic.supportNumber || ""
  };
}
