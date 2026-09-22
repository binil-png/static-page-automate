import { createPartFromBase64, createPartFromText, GoogleGenAI } from "@google/genai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const RESOURCE_DIR = path.join(process.cwd(), "resource");
const OUTPUT_FILE = path.join(process.cwd(), "index.html");
const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash"
];
const MAX_ATTEMPTS = 2;
const IMAGE_EXTENSIONS = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif"
};
const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

function getMimeType(fileName) {
  return IMAGE_EXTENSIONS[path.extname(fileName).toLowerCase()] || null;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function prettyLabel(key) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => String(value).trim() !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => String(value).trim() !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

function extractSheetRef() {
  const raw = process.argv[2] || process.env.GOOGLE_SHEET_URL || process.env.GOOGLE_SHEET_ID;
  if (!raw) {
    throw new Error("Set GOOGLE_SHEET_ID or GOOGLE_SHEET_URL, or pass the sheet URL as the first argument.");
  }

  const idMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = raw.match(/[?#&]gid=([0-9]+)/);

  return {
    sheetId: idMatch ? idMatch[1] : raw.trim(),
    gid: process.env.GOOGLE_SHEET_GID || (gidMatch ? gidMatch[1] : ""),
    tab: process.env.GOOGLE_SHEET_TAB || ""
  };
}

function buildSheetCsvUrl({ sheetId, gid, tab }) {
  if (gid) {
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  }

  if (tab) {
    return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  }

  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet (${response.status}). Share it as Anyone with the link can view.`);
  }

  return response.text();
}

async function fetchSheetRows() {
  const ref = extractSheetRef();
  const url = buildSheetCsvUrl(ref);
  console.log(`Fetching clinic data from Google Sheet ${ref.sheetId}...`);
  const csv = await fetchText(url);

  if (csv.includes("<!DOCTYPE html") || csv.includes("<HTML")) {
    throw new Error("Google Sheet is not readable. Share it as Anyone with the link can view.");
  }

  const rows = parseCsv(csv);
  if (rows.length === 0) {
    throw new Error("Google Sheet is empty.");
  }

  return rows;
}

function extractUrl(value) {
  const text = String(value || "").trim();
  const formula = text.match(/IMAGE\("([^"]+)"/i);
  if (formula) {
    return formula[1];
  }

  const match = text.match(/https?:\/\/[^\s,"]+/i);
  return match ? match[0] : "";
}

function isImageField(key) {
  return /^(logo|banner|hero|image|photo|asset)(_|$)/.test(key)
    || /(logo|banner|hero|image|photo|asset).*(url|image|img|link)$/.test(key)
    || /^(url|image_url|img_url)$/.test(key);
}

function looksLikeImageUrl(url) {
  if (!url) {
    return false;
  }

  return /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)
    || /drive\.google\.com|docs\.google\.com|googleusercontent\.com/i.test(url);
}

function isKeyValueSheet(rows) {
  if (!rows[0] || rows[0].length !== 2) {
    return false;
  }

  const header = rows[0].map(normalizeKey);
  if (
    (header[0] === "key" || header[0] === "field" || header[0] === "name")
    && (header[1] === "value" || header[1] === "details" || header[1] === "data")
  ) {
    return true;
  }

  const dataRows = rows.slice(1);
  const keyLikeCount = dataRows.filter((row) => /^[a-z][a-z0-9_]*$/.test(normalizeKey(row[0]))).length;
  return dataRows.length > 0 && keyLikeCount >= Math.ceil(dataRows.length * 0.6);
}

function rowsToClinicRecord(rows) {
  if (isKeyValueSheet(rows)) {
    const record = {};
    const firstKey = normalizeKey(rows[0][0]);
    const start = firstKey === "key" || firstKey === "field" || firstKey === "name" ? 1 : 0;

    for (const row of rows.slice(start)) {
      const key = normalizeKey(row[0]);
      if (key) {
        record[key] = String(row[1] || "").trim();
      }
    }

    return record;
  }

  const headers = rows[0].map(normalizeKey);
  const values = rows[1] || [];
  const record = {};

  headers.forEach((key, index) => {
    if (key) {
      record[key] = String(values[index] || "").trim();
    }
  });

  return record;
}

function splitClinicAndImages(record) {
  const clinicDetails = {};
  const images = [];

  for (const [key, value] of Object.entries(record)) {
    const url = extractUrl(value);
    if (url && (isImageField(key) || looksLikeImageUrl(url))) {
      images.push({ key, url });
    } else if (value) {
      clinicDetails[key] = value;
    }
  }

  return { clinicDetails, images };
}

function toDirectImageUrl(url) {
  const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fileIdMatch && /drive\.google\.com|docs\.google\.com/.test(url)) {
    return `https://drive.google.com/uc?export=download&id=${fileIdMatch[1]}`;
  }

  return url;
}

function extensionForImage(mimeType, url) {
  if (MIME_TO_EXT[mimeType]) {
    return MIME_TO_EXT[mimeType];
  }

  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (IMAGE_EXTENSIONS[ext]) {
      return ext;
    }
  } catch {
    // Use the default below when the URL has no usable file extension.
  }

  return ".jpg";
}

async function downloadSheetImage(image, index) {
  const directUrl = toDirectImageUrl(image.url);
  console.log(`Downloading ${image.key} image...`);
  const response = await fetch(directUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download image ${image.key} (${response.status}). Share the file as Anyone with the link can view.`);
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType.includes("text/html")) {
    throw new Error(`Image ${image.key} is not publicly readable. Share the file as Anyone with the link can view.`);
  }

  const mimeType = contentType.startsWith("image/") ? contentType : "image/jpeg";
  const bytes = Buffer.from(await response.arrayBuffer());
  const fileName = `${image.key || `image_${index + 1}`}${extensionForImage(mimeType, image.url)}`;
  const relativePath = path.posix.join("resource", fileName);
  await writeFile(path.join(RESOURCE_DIR, fileName), bytes);

  return {
    imagePart: createPartFromBase64(bytes.toString("base64"), mimeType),
    relativePath
  };
}

async function loadClinicFromSheet() {
  const rows = await fetchSheetRows();
  const { clinicDetails, images } = splitClinicAndImages(rowsToClinicRecord(rows));

  if (Object.keys(clinicDetails).length === 0) {
    throw new Error("No clinic details found in the Google Sheet.");
  }

  if (images.length === 0) {
    throw new Error("No image links found in the Google Sheet.");
  }

  await mkdir(RESOURCE_DIR, { recursive: true });

  const imageParts = [];
  const relativePaths = [];

  for (const [index, image] of images.entries()) {
    const loaded = await downloadSheetImage(image, index);
    imageParts.push(loaded.imagePart);
    relativePaths.push(loaded.relativePath);
  }

  return { clinicDetails, imageParts, relativePaths };
}

async function generateContentWithRetry(contents) {
  let lastError;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`Generating page with ${model} (attempt ${attempt})...`);
        return await gemini.models.generateContent({ model, contents });
      } catch (error) {
        lastError = error;
        const retryable = error.status === 503 || error.status === 429;
        if (!retryable || attempt === MAX_ATTEMPTS) {
          break;
        }
        const delayMs = 1000 * (2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

function extractHtml(text) {
  const fencedMatch = text.match(/```html\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const doctypeIndex = text.search(/<!DOCTYPE html/i);
  if (doctypeIndex >= 0) {
    return text.slice(doctypeIndex).trim();
  }

  return text.trim();
}

function buildPrompt(clinicDetails, relativePaths) {
  const imageList = relativePaths.map((imagePath) => `- ${imagePath}`).join("\n");
  const details = Object.entries(clinicDetails)
    .map(([key, value]) => `- ${prettyLabel(key)}: ${value}`)
    .join("\n");

  return `You are a front-end designer. Recreate a complete static marketing website from the attached brand images and the clinic data below.

Clinic details:
${details}

Brand assets downloaded from the Google Sheet:
${imageList}

Requirements:
- Return ONLY a full HTML document. No markdown. No explanation.
- Single file with embedded CSS and a little JS if needed.
- Use the attached images as the visual source of truth for colors, logo, layout mood, and wording.
- Use ONLY the clinic details above. Do not invent a different clinic name, phone number, location, or tagline.
- If a detail is not listed, omit it instead of making one up.
- Reference the images with these exact relative src values: ${relativePaths.map((imagePath) => `"${imagePath}"`).join(", ")}
- Include a sticky header with logo, hero using the banner/hero image when provided, about, services, location, contact, and footer.
- Make it look like a real clinic website: professional, responsive, accessible, modern, production-quality.
- Add working in-page navigation and a click-to-call phone link for each phone number.`;
}

const { clinicDetails, imageParts, relativePaths } = await loadClinicFromSheet();

const aiResponse = await generateContentWithRetry([
  {
    role: "user",
    parts: [createPartFromText(buildPrompt(clinicDetails, relativePaths)), ...imageParts]
  }
]);

const html = extractHtml(aiResponse.text || "");
await writeFile(OUTPUT_FILE, html, "utf8");
console.log(`Static page written to ${OUTPUT_FILE}`);
