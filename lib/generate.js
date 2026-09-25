import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPartFromBase64, createPartFromText, GoogleGenAI } from "@google/genai";
import { getDriveClient } from "./googleAuth.js";
import { fetchGoogleReviews, formatReviewsForPrompt } from "./googleReviews.js";
import { findClinicFolder } from "./clinicFolder.js";
import { needsGeneratedLogo, wantsPaidExtraPages, wantsReadyPhotoGallery } from "./clinics.js";
import { pickReferenceDesign, referenceLayoutExcerpt, referenceStyleGuide } from "./pageReferences.js";
import { getAnthropicApiKey, getOpenAiApiKey, getShareSettings, normalizeProvider } from "./setupConfig.js";

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash"
];
const CLAUDE_MODELS = [
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-opus-4-6"
];
const CHATGPT_MODELS = [
  "gpt-5-chat-latest",
  "gpt-5",
  "gpt-4.1"
];
const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_ATTEMPTS = 2;
const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg"
};

const SKIP_URL_HOSTS = [
  "maps.app.goo.gl",
  "maps.google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "share.google",
  "ufile.io"
];

const FIELD_LABELS = {
  clinicName: "Clinic name",
  tagline: "Tagline / banner caption",
  filesLink: "Uploaded files link",
  address: "Full address",
  contactNumbers: "Contact numbers",
  email: "Email",
  supportNumber: "Customer support / enquiry number",
  timing: "Clinic timing",
  bookingWidget: "Online booking URL (appointment button)",
  mapLocation: "Google Maps location",
  welcomeText: "Welcome text",
  about: "About the clinic",
  services: "Specialty / services",
  socialLinks: "Social media links",
  logo: "Clinic logo note or link",
  photoGallery: "Photo gallery requested",
  extraPages: "Extra pages requested",
  domainSuggestions: "Domain name suggestions",
  terms: "Terms and conditions"
};

function extractUrls(value) {
  return [...String(value || "").matchAll(/https?:\/\/[^\s,"'<>]+/gi)].map((match) => match[0]);
}

function extractBookingUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const srcMatch = raw.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  if (srcMatch?.[1] && /^https?:\/\//i.test(srcMatch[1])) {
    return srcMatch[1].trim();
  }

  const urls = extractUrls(raw);
  if (urls.length) {
    return urls[0];
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw.split(/\s/)[0];
  }

  return "";
}

function shouldSkipUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SKIP_URL_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
  } catch {
    return true;
  }
}

function extractDriveId(url) {
  const folderMatch = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) {
    return folderMatch[1];
  }

  const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fileIdMatch && /drive\.google\.com|docs\.google\.com/.test(url)) {
    return fileIdMatch[1];
  }

  return null;
}

function isImageFile(file) {
  const mime = String(file.mimeType || "").toLowerCase();
  const name = String(file.name || "");
  if (mime.startsWith("image/")) {
    return true;
  }
  if (/\.(jpe?g|png|webp|gif|svg|bmp|heic|heif|tif|tiff|avif|jfif)$/i.test(name)) {
    return true;
  }
  return mime === "application/octet-stream" && /logo|icon|banner|hero|about|gallery|photo|image|img|pic/i.test(name);
}

function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) {
    return "";
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    return "image/jpeg";
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return "image/webp";
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return "image/bmp";
  }
  const head = bytes.subarray(0, 80).toString("ascii").toLowerCase();
  if (head.includes("<svg") || head.includes("<?xml")) {
    return "image/svg+xml";
  }
  return "";
}

function normalizeMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const ROLE_PLACEMENT = {
  logo: "Use in the sticky header brand area and a small footer or about repeat. Never stretch this as a full-width hero.",
  banner: "Use as the full-width hero/banner directly under the header.",
  about: "Use in the About section next to the clinic description.",
  team: "Use in a team section if extra pages were requested; otherwise in About.",
  service: "Use in About or the photo gallery. Do not place this image at the top of a service card.",
  gallery: "Use in a photo gallery section. Do not use this as the logo or the main hero."
};

function readImageSize(bytes, mimeType) {
  try {
    if ((mimeType || "").includes("png") && bytes.length > 24 && bytes[0] === 0x89) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if ((mimeType || "").includes("jpeg") || (mimeType || "").includes("jpg")) {
      let index = 2;
      while (index < bytes.length - 8 && bytes[index] === 0xFF) {
        const marker = bytes[index + 1];
        if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
          return {
            height: bytes.readUInt16BE(index + 5),
            width: bytes.readUInt16BE(index + 7)
          };
        }
        index += 2 + bytes.readUInt16BE(index + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function imageBaseName(name) {
  const last = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
  return last.split("?")[0].replace(/\.[^.]+$/, "").trim().toLowerCase();
}

function parseServiceItems(value) {
  const parts = String(value || "")
    .replace(/\r/g, "\n")
    .split(/\n+|[,;•]+|(?:\s+\/\s+)/);
  const items = [];
  const seen = new Set();

  for (const part of parts) {
    const text = part.replace(/^[\s\d.)\-–—*]+/, "").replace(/\s+/g, " ").trim();
    const key = normalizeMatch(text);
    if (text.length < 2 || text.length > 80 || key.length < 3 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(text);
  }

  return items.slice(0, 16);
}

function matchingServiceName(fileName, serviceItems) {
  const fileKey = normalizeMatch(imageBaseName(fileName) || fileName);
  if (fileKey.length < 3 || !serviceItems.length) {
    return "";
  }

  let best = "";
  let bestLen = 0;
  for (const service of serviceItems) {
    const serviceKey = normalizeMatch(service);
    if (serviceKey.length >= 3 && (fileKey.includes(serviceKey) || serviceKey.includes(fileKey)) && serviceKey.length > bestLen) {
      best = service;
      bestLen = serviceKey.length;
    }
    for (const word of String(service).toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 4 && fileKey.includes(word) && word.length > bestLen) {
        best = service;
        bestLen = word.length;
      }
    }
  }

  return best;
}

function fileLooksLikeLogo(name, serviceItems = []) {
  const text = String(name || "").toLowerCase();
  if (matchingServiceName(name, serviceItems)) {
    return false;
  }
  return text.includes("logo") || text.includes("icon");
}

function inferImageRole(name, source, size, taken, serviceItems = []) {
  if (fileLooksLikeLogo(name, serviceItems)) {
    return taken.has("logo") ? "gallery" : "logo";
  }
  const label = `${name || ""} ${source || ""}`.toLowerCase();
  if (matchingServiceName(name, serviceItems) || /service|treatment|procedure/.test(label)) {
    return "service";
  }
  if (/banner|hero|cover|wide/.test(label)) {
    return taken.has("banner") ? "gallery" : "banner";
  }
  if (/about|building|exterior|interior|facility|reception/.test(label)) {
    return "about";
  }
  if (/team|staff|doctor|dentist/.test(label)) {
    return "team";
  }
  if (/gallery|photo/.test(label)) {
    return "gallery";
  }

  const ratio = size?.width && size?.height ? size.width / size.height : 0;
  if (!taken.has("banner") && ratio >= 1.55) {
    return "banner";
  }
  if (!taken.has("banner")) {
    return "banner";
  }
  return "gallery";
}

function roleFileName(role, counts, ext) {
  counts[role] = (counts[role] || 0) + 1;
  if ((role === "logo" || role === "banner" || role === "about") && counts[role] === 1) {
    return `${role}${ext}`;
  }
  return `${role}-${counts[role]}${ext}`;
}

function forceLogo(images, serviceItems = []) {
  if (!images.length || images.some((image) => image.role === "logo")) {
    return images;
  }

  const index = images.findIndex((image) => fileLooksLikeLogo(image.originalName, serviceItems));
  if (index < 0) {
    return images;
  }

  const chosen = images[index];
  const ext = extensionForImage(chosen.mimeType, chosen.originalName);
  images[index] = {
    ...chosen,
    role: "logo",
    fileName: `logo${ext}`,
    instruction: `The next attached image is the logo. HTML src must be exactly "logo${ext}". Original file name: ${chosen.originalName || "unknown"}. ${ROLE_PLACEMENT.logo}`
  };
  return images;
}

function logoPriority(name, serviceItems = []) {
  if (matchingServiceName(name, serviceItems)) {
    return 4;
  }
  const base = imageBaseName(name);
  const text = String(name || "").toLowerCase();
  if (base === "logo" || /^logo\s*\(\d+\)$/.test(base)) {
    return 0;
  }
  if (text.includes("logo")) {
    return 1;
  }
  if (text.includes("icon")) {
    return 2;
  }
  return 3;
}

function assignImageMeta(image, originalName, source, taken, counts, serviceItems = []) {
  const size = readImageSize(Buffer.from(image.dataUri.split(",")[1], "base64"), image.mimeType);
  const role = inferImageRole(originalName, source, size, taken, serviceItems);
  taken.add(role);
  const ext = extensionForImage(image.mimeType, originalName);
  const fileName = roleFileName(role, counts, ext);
  const matchedService = role === "service" ? matchingServiceName(originalName, serviceItems) : "";
  const instruction = matchedService
    ? `The next attached image is for the "${matchedService}" service tile. HTML src must be exactly "${fileName}". Original file name: ${originalName || "unknown"}. ${ROLE_PLACEMENT.service}`
    : `The next attached image is the ${role}. HTML src must be exactly "${fileName}". Original file name: ${originalName || "unknown"}. ${ROLE_PLACEMENT[role]}`;
  return {
    ...image,
    role,
    matchedService,
    originalName: originalName || fileName,
    source: source || "",
    fileName,
    instruction
  };
}

function imageFromBytes(bytes, contentType, url, index) {
  const sniffed = sniffImageMime(bytes);
  const mimeType = (contentType.startsWith("image/") ? contentType : "") || sniffed;
  if (!mimeType) {
    throw new Error(`Not an image (${contentType || "unknown type"})`);
  }

  const ext = extensionForImage(mimeType, url);
  const fileName = `clinic-image-${index + 1}${ext}`;

  return {
    fileName,
    mimeType,
    imagePart: createPartFromBase64(bytes.toString("base64"), mimeType),
    dataUri: `data:${mimeType};base64,${bytes.toString("base64")}`
  };
}

async function downloadDriveImage(fileId, url, index, mimeHint) {
  const drive = await getDriveClient();
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  const headerType = (
    (response.headers["content-type"] || response.headers.get?.("content-type") || "")
  ).split(";")[0].trim().toLowerCase();
  const bytes = Buffer.from(response.data);
  const hinted = String(mimeHint || "").toLowerCase();
  const contentType = headerType.startsWith("image/")
    ? headerType
    : (hinted.startsWith("image/") ? hinted : (sniffImageMime(bytes) || headerType || "image/jpeg"));
  return imageFromBytes(bytes, contentType, url, index);
}

function extensionForImage(mimeType, url) {
  if (MIME_TO_EXT[mimeType]) {
    return MIME_TO_EXT[mimeType];
  }

  try {
    const ext = new URL(url).pathname.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/)?.[0];
    if (ext) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    // Keep the default when the URL has no file extension.
  }

  return ".jpg";
}

function collectImageCandidates(clinic) {
  const entries = [];
  for (const [key, value] of Object.entries(clinic)) {
    if (key === "extraFields" || key === "id" || typeof value !== "string") {
      continue;
    }
    entries.push({ source: key, value });
  }
  for (const [key, value] of Object.entries(clinic.extraFields || {})) {
    entries.push({ source: key, value });
  }

  const seen = new Set();
  const urls = [];

  for (const entry of entries) {
    for (const url of extractUrls(entry.value)) {
      if (shouldSkipUrl(url) || seen.has(url)) {
        continue;
      }
      seen.add(url);
      urls.push({ url, source: entry.source });
    }
  }

  return urls;
}

async function listFolderChildren(drive, folderId) {
  const files = [];
  let pageToken;
  const query = {
    q: `'${folderId}' in parents and trashed = false`,
    fields: "nextPageToken, files(id, name, mimeType, shortcutDetails)",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  };

  do {
    let result;
    try {
      result = await drive.files.list({ ...query, pageToken, corpora: "allDrives" });
    } catch {
      result = await drive.files.list({ ...query, pageToken });
    }
    files.push(...(result.data.files || []));
    pageToken = result.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function addDriveImageSource(drive, fileId, seenIds, imageFiles, depth = 0, source = "filesLink") {
  if (!fileId || seenIds.has(fileId) || depth > 6) {
    return;
  }
  seenIds.add(fileId);

  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, shortcutDetails",
    supportsAllDrives: true
  });
  const file = meta.data;

  if (file.mimeType === "application/vnd.google-apps.shortcut" && file.shortcutDetails?.targetId) {
    seenIds.delete(fileId);
    await addDriveImageSource(drive, file.shortcutDetails.targetId, seenIds, imageFiles, depth, source);
    return;
  }

  if (file.mimeType === "application/vnd.google-apps.folder") {
    const children = await listFolderChildren(drive, file.id);
    if (depth === 0) {
      console.log(`Drive folder "${file.name}" has ${children.length} item(s).`);
    }
    for (const child of children) {
      await addDriveImageSource(drive, child.id, seenIds, imageFiles, depth + 1, source);
    }
    return;
  }

  if (isImageFile(file)) {
    imageFiles.push({ ...file, source });
  }
}

async function collectDriveImageFiles(clinic) {
  const drive = await getDriveClient();
  const seenIds = new Set();
  const imageFiles = [];
  const httpUrls = [];
  let folder = { exists: false, folderId: "", folderName: "", folderLink: "" };

  for (const candidate of collectImageCandidates(clinic)) {
    const driveId = extractDriveId(candidate.url);
    if (!driveId) {
      httpUrls.push(candidate);
      continue;
    }

    try {
      await addDriveImageSource(drive, driveId, seenIds, imageFiles, 0, candidate.source);
    } catch (error) {
      console.warn(`Skipped Drive item ${candidate.url}: ${error.message}`);
    }
  }

  try {
    folder = await findClinicFolder(clinic);
    if (folder.exists && folder.folderId) {
      console.log(`Using Google Drive folder: ${folder.folderName} (${folder.folderId})`);
      const before = imageFiles.length;
      await addDriveImageSource(drive, folder.folderId, seenIds, imageFiles, 0, "driveFolder");
      console.log(`Loaded ${imageFiles.length - before} Drive image(s) from "${folder.folderName}".`);
    } else {
      console.warn(`No Google Drive folder found for ${clinic.clinicName || clinic.email || "this clinic"}.`);
    }
  } catch (error) {
    console.warn(`Drive folder search skipped: ${error.message}`);
  }

  return { imageFiles, httpUrls, folder };
}

async function downloadImage(url, index) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  return imageFromBytes(bytes, contentType, url, index);
}

async function loadClinicImages(clinic) {
  const images = [];
  const warnings = [];
  const taken = new Set();
  const counts = {};
  const serviceItems = parseServiceItems(clinic.services);
  const { imageFiles, httpUrls, folder } = await collectDriveImageFiles(clinic);

  const rankedFiles = [...imageFiles].sort((left, right) => (
    logoPriority(left.name, serviceItems) - logoPriority(right.name, serviceItems)
  ));

  for (const file of rankedFiles.slice(0, 20)) {
    try {
      const downloaded = await downloadDriveImage(file.id, file.name || file.id, images.length, file.mimeType);
      images.push(assignImageMeta(downloaded, file.name || file.id, file.source, taken, counts, serviceItems));
    } catch (error) {
      const message = `Could not use Drive image ${file.name || file.id}: ${error.message}`;
      warnings.push(message);
      console.warn(message);
    }
  }

  for (const candidate of httpUrls) {
    if (images.length >= 20) {
      break;
    }
    try {
      const downloaded = await downloadImage(candidate.url, images.length);
      images.push(assignImageMeta(downloaded, candidate.url, candidate.source, taken, counts, serviceItems));
    } catch (error) {
      const message = `Could not use image ${candidate.url}: ${error.message}`;
      warnings.push(message);
      console.warn(message);
    }
  }

  forceLogo(images, serviceItems);
  if (!folder.exists) {
    warnings.push("No Google Drive folder was found for this clinic.");
  }
  if (images.length === 0) {
    warnings.push(folder.exists
      ? `Drive folder "${folder.folderName}" was found, but it has no usable images.`
      : "No clinic images could be loaded from the sheet or Google Drive.");
  }

  return { images, warnings, folder };
}

function formatClinicDetails(clinic) {
  const lines = [];

  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    if (clinic[key]) {
      lines.push(`- ${label}: ${clinic[key]}`);
    }
  }

  for (const [key, value] of Object.entries(clinic.extraFields || {})) {
    lines.push(`- ${key}: ${value}`);
  }

  return lines.join("\n");
}

function wantsFlag(value) {
  return /^yes\b/i.test(String(value || "").trim());
}

function parseManualTestimonials(value) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }

  const chunks = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const items = [];

  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 2 && lines[0].length <= 60 && !/[.!?]$/.test(lines[0])) {
      items.push({
        author: lines[0],
        text: lines.slice(1).join(" "),
        rating: 0,
        relativeTime: ""
      });
      continue;
    }

    if (lines.length >= 2 && lines[lines.length - 1].length <= 60 && !/[.!?]$/.test(lines[lines.length - 1])) {
      items.push({
        author: lines[lines.length - 1],
        text: lines.slice(0, -1).join(" "),
        rating: 0,
        relativeTime: ""
      });
      continue;
    }

    const split = chunk.match(/^(.{2,50}?)\s*[:\-–—]\s+([\s\S]+)$/);
    if (split) {
      items.push({
        author: split[1].trim(),
        text: split[2].trim(),
        rating: 0,
        relativeTime: ""
      });
      continue;
    }

    const trailing = chunk.match(/^([\s\S]+?)\s+[\-–—]\s+(.{2,50})$/);
    if (trailing && !/[.!?]$/.test(trailing[2])) {
      items.push({
        author: trailing[2].trim(),
        text: trailing[1].trim(),
        rating: 0,
        relativeTime: ""
      });
      continue;
    }

    items.push({
      author: "",
      text: chunk,
      rating: 0,
      relativeTime: ""
    });
  }

  return uniqueTestimonialItems(items).slice(0, 12);
}

function uniqueTestimonialItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = String(item?.text || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function formatManualTestimonialsForPrompt(value) {
  const items = parseManualTestimonials(value);
  if (!items.length) {
    return "No manual testimonials were entered.";
  }
  return items.map((item, index) => {
    const name = item.author ? item.author : "(no name provided — do not invent a name)";
    return `${index + 1}. Reviewer name: ${name}\n   Quote: ${item.text}`;
  }).join("\n");
}

function testimonialsPromptGuide(clinic, reviewData = { reviews: [] }) {
  const items = uniqueTestimonialItems([
    ...parseManualTestimonials(clinic.manualTestimonials),
    ...(reviewData.reviews || [])
  ]);
  if (!items.length) {
    return "Do not add a testimonials section. No testimonials were entered and no Google reviews are available.";
  }

  const list = items.map((item, index) => {
    const name = item.author ? item.author : "(no name provided — do not invent a name)";
    return `${index + 1}. Reviewer name: ${name}\n   Quote: ${item.text}`;
  }).join("\n");

  return `Create exactly ONE testimonials section with id="testimonials". Use one horizontal swipe/scroll row. Render each unique review below as exactly one card. Never repeat a quote. Never add a second testimonials block. Do not copy sample testimonials from reference pages. If a reviewer name is provided, show that name on the card. If no name is provided, omit the name.

Unique testimonials to render (each once):
${list}`;
}

function firstClinicPhoneDigits(clinic = {}) {
  const raw = [clinic.contactNumbers, clinic.supportNumber].filter(Boolean).join(" ");
  const matches = String(raw).match(/(?:\+?\d[\d\s\-()]{8,}\d)/g) || [];
  for (const match of matches) {
    let digits = match.replace(/\D/g, "");
    if (digits.length < 10) {
      continue;
    }
    if (digits.length === 10) {
      digits = `91${digits}`;
    } else if (digits.length === 11 && digits.startsWith("0")) {
      digits = `91${digits.slice(1)}`;
    }
    return digits;
  }
  return "";
}

function clinicWhatsAppUrl(clinic = {}) {
  const digits = firstClinicPhoneDigits(clinic);
  return digits ? `https://wa.me/${digits}` : "";
}

function whatsappPromptGuide(clinic = {}) {
  const url = clinicWhatsAppUrl(clinic);
  const digits = firstClinicPhoneDigits(clinic);
  if (!url) {
    return "No clinic phone was provided. Do not invent a WhatsApp link.";
  }
  return `In the social media icon row, include exactly one WhatsApp brand icon. Link it to ${url} (clinic phone ${digits}). Do not add a second WhatsApp icon. Do not use a tel: link for that icon.`;
}

const COLOR_PALETTES = [
  {
    id: "mint",
    family: "teal",
    deep: "#0d9488",
    mid: "#2dd4bf",
    bright: "#14b8a6",
    pale: "#ccfbf1",
    wash: "#f0fdfa",
    ink: "#115e59",
    onDeep: "#ffffff",
    onMid: "#134e4a",
    quote: "#5eead4"
  },
  {
    id: "sky",
    family: "sky",
    deep: "#0284c7",
    mid: "#38bdf8",
    bright: "#0ea5e9",
    pale: "#e0f2fe",
    wash: "#f0f9ff",
    ink: "#0c4a6e",
    onDeep: "#ffffff",
    onMid: "#075985",
    quote: "#7dd3fc"
  },
  {
    id: "sage",
    family: "emerald",
    deep: "#059669",
    mid: "#34d399",
    bright: "#10b981",
    pale: "#d1fae5",
    wash: "#ecfdf5",
    ink: "#065f46",
    onDeep: "#ffffff",
    onMid: "#064e3b",
    quote: "#6ee7b7"
  },
  {
    id: "blush",
    family: "rose",
    deep: "#e11d48",
    mid: "#fb7185",
    bright: "#f43f5e",
    pale: "#ffe4e6",
    wash: "#fff1f2",
    ink: "#9f1239",
    onDeep: "#ffffff",
    onMid: "#881337",
    quote: "#fda4af"
  },
  {
    id: "lilac",
    family: "violet",
    deep: "#7c3aed",
    mid: "#a78bfa",
    bright: "#8b5cf6",
    pale: "#ede9fe",
    wash: "#f5f3ff",
    ink: "#5b21b6",
    onDeep: "#ffffff",
    onMid: "#4c1d95",
    quote: "#c4b5fd"
  },
  {
    id: "peach",
    family: "orange",
    deep: "#ea580c",
    mid: "#fb923c",
    bright: "#f97316",
    pale: "#ffedd5",
    wash: "#fff7ed",
    ink: "#9a3412",
    onDeep: "#ffffff",
    onMid: "#7c2d12",
    quote: "#fdba74"
  },
  {
    id: "aqua",
    family: "cyan",
    deep: "#0891b2",
    mid: "#22d3ee",
    bright: "#06b6d4",
    pale: "#cffafe",
    wash: "#ecfeff",
    ink: "#155e75",
    onDeep: "#ffffff",
    onMid: "#164e63",
    quote: "#67e8f9"
  }
];

const ACCENT_FAMILIES = ["teal", "cyan", "emerald", "indigo", "rose", "amber", "violet", "sky", "orange", "blue", "fuchsia", "pink", "lime", "red"];
const PALETTE_STATE_FILE = path.join(process.cwd(), "last-palette.json");

function loadLastPaletteIndex() {
  try {
    const stored = JSON.parse(readFileSync(PALETTE_STATE_FILE, "utf8"));
    return COLOR_PALETTES.findIndex((item) => item.id === stored.id);
  } catch {
    return -1;
  }
}

function persistLastPalette(id) {
  try {
    writeFileSync(PALETTE_STATE_FILE, JSON.stringify({ id }));
  } catch {
    // keep the in-memory rotation even if the file cannot be saved
  }
}

let lastPaletteIndex = loadLastPaletteIndex();

function pickColorPalette() {
  const available = COLOR_PALETTES.filter((_, index) => index !== lastPaletteIndex);
  const next = available[Math.floor(Math.random() * available.length)] || COLOR_PALETTES[0];
  lastPaletteIndex = COLOR_PALETTES.indexOf(next);
  persistLastPalette(next.id);
  return next;
}

function applyPaletteToHtml(html, palette = COLOR_PALETTES[0]) {
  const family = palette.family;
  const foreign = ACCENT_FAMILIES.filter((name) => name !== family).join("|");
  let result = String(html || "").replace(
    new RegExp(`\\b(${foreign})-([0-9]{2,3})\\b`, "gi"),
    `${family}-$2`
  );

  for (const other of COLOR_PALETTES) {
    if (other.id === palette.id) {
      continue;
    }
    for (const slot of ["deep", "mid", "bright", "pale", "wash", "ink", "onDeep", "onMid", "quote"]) {
      const from = other[slot];
      const to = palette[slot];
      if (!from || !to || from.toLowerCase() === to.toLowerCase()) {
        continue;
      }
      result = result.split(from).join(to);
      result = result.split(from.toUpperCase()).join(to);
    }
  }
  return lightenDarkSurfaces(result, palette);
}

function lightenDarkSurfaces(html, palette = COLOR_PALETTES[0]) {
  const family = palette.family;
  let result = String(html || "");
  result = result.replace(/\bbg-black\b/gi, `bg-${family}-50`);
  result = result.replace(/\bbg-neutral-950\b/gi, `bg-${family}-50`);
  result = result.replace(/\b(?:bg|from|via|to)-(?:slate|neutral|zinc|stone|gray|black)-(?:800|900|950)\b/gi, (token) => {
    if (/^via-/i.test(token)) {
      return "via-white";
    }
    if (/^to-/i.test(token)) {
      return `to-${family}-100`;
    }
    return token.replace(/-(?:slate|neutral|zinc|stone|gray|black)-(?:800|900|950)$/i, `-${family}-50`);
  });
  result = result.replace(new RegExp(`\\b(?:bg|from)-${family}-(?:800|900|950)\\b`, "gi"), (token) => (
    token.replace(/-(?:800|900|950)$/i, "-50")
  ));
  result = result.replace(new RegExp(`\\bvia-${family}-(?:700|800|900|950)\\b`, "gi"), "via-white");
  result = result.replace(new RegExp(`\\bto-${family}-(?:800|900|950)\\b`, "gi"), `to-${family}-100`);
  result = result.replace(/\bbg-(?:slate|neutral|zinc|stone|gray)-950(?:\/\d+)?\b/gi, `bg-${family}-50`);
  result = result.replace(new RegExp(`\\bbg-${family}-950(?:\\/\\d+)?\\b`, "gi"), `bg-${family}-50`);
  return result;
}

function pageStyleGuide(palette, reference) {
  if (reference) {
    return `${referenceStyleGuide(reference, palette)}

Layout excerpts from every file in public/references (copy structure only; ignore sample clinic text):
${referenceLayoutExcerpt(reference)}`;
  }

  const family = palette.family;
  return `Visual style only. Copy this look. Do not copy any clinic name, address, phone, email, doctor, city, years, services, or body copy from any reference page.

Stack:
- Tailwind CSS v4 from https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4
- Lucide icons from https://unpkg.com/lucide@latest and call lucide.createIcons() at the end
- Clinic Google fonts: Playfair Display or Plus Jakarta Sans for headings; Nunito, Poppins, DM Sans, or Source Sans 3 for body

This generation MUST use the ${family} color palette only. Keep the whole page light and clinic-friendly. Do not use black, slate-900, or dark full-width backgrounds.
Accent hex values: deep ${palette.deep}, mid ${palette.mid}, bright ${palette.bright}, pale ${palette.pale}.
Use Tailwind classes such as bg-${family}-50, bg-${family}-100, text-${family}-700, bg-${family}-500. Never use bg-${family}-900 or from-${family}-900.

Clinic typography:
- Headings: Playfair Display or Plus Jakarta Sans
- Body: Nunito, Poppins, or DM Sans
- Comfortable sizes, generous line-height, soft letter-spacing on labels

Colors and surfaces:
- Page: cream or white (bg-white or ${palette.wash}), slate-700 body text
- Top utility bar: bg-${family}-50 text-${family}-800, never a dark bar
- Sticky header: white/95 backdrop-blur, soft shadow
- Hero: light wash from-${family}-50 via-white to-${family}-100, dark readable type
- Primary CTA: bg-${family}-500 text-white rounded-full or rounded-xl
- About/services/gallery: white cards, soft borders, rounded-2xl, gentle shadow
- Contact: one light card + one form
- Footer: ${palette.wash} or ${family}-50, dark text, not a black footer
- Testimonials: white cards, ${family} quote mark, swipe row

Layout:
- max-w-7xl mx-auto px-4 sm:px-6 lg:px-8
- sticky header with logo (if provided) plus clinic name, desktop and mobile nav starting with Home (#home), optional phone chip labeled Contact, mobile hamburger
- sections only when this clinic's data supports them: home/hero, about, services, gallery, testimonials, contact, footer
- Book an appointment uses the provided booking URL, not a dummy #contact link, when a booking URL exists
- Do not invent highlight stats, years, or feature cards unless that fact is in the clinic sheet data`;
}

function describeResources(images) {
  if (!images.length) {
    return "- No downloadable brand images were found in the sheet or the clinic Google Drive folder.";
  }

  return images.map((image) => (
    `- ${image.fileName} | role=${image.role} | original=${image.originalName} | source=${image.source || "unknown"} | ${ROLE_PLACEMENT[image.role] || "Use this clinic photo on the page."}`
  )).join("\n");
}

function buildPlannerPrompt(clinic, images, reviewData = { reviews: [] }, palette = COLOR_PALETTES[0], reference) {
  return `You are a senior web-production planner. Study the clinic data from Google Sheets and the listed brand resources. Then write ONE detailed prompt that another model will follow to generate a complete static clinic website.

Clinic data from Google Sheet:
${formatClinicDetails(clinic)}

Available website resources (image files that will be attached in the next step):
${describeResources(images)}

Google Maps reviews fetched from the clinic location link:
${formatReviewsForPrompt(reviewData)}

Manual testimonials entered in the generator: ${parseManualTestimonials(clinic.manualTestimonials).length ? `${parseManualTestimonials(clinic.manualTestimonials).length} unique review(s). Tell the page model to render each review once and show any reviewer name. Do not paste the quote list in your output; the next step already has the canonical list.` : "none"}

Extra-pages requested: ${wantsPaidExtraPages(clinic.extraPages) ? "yes — include extra pages only if that copy exists" : "no — do not add facilities, team, or doctor-listing pages. Still include testimonials if the generator testimonials box has text."}
Photo gallery requested: ${wantsReadyPhotoGallery(clinic.photoGallery) ? "yes — add a Gallery menu item and show ALL Drive photos in a gallery section. Also use photos in hero and about where they fit." : "no — do not add a gallery section or Gallery menu link. Still use Drive photos in hero or about. Do not put photos on service cards."}

Visual style to follow (layout, colors, type, components only):
${pageStyleGuide(palette, reference)}

Your output must be a production-ready prompt that includes:
- The clinic specialty inferred only from the provided about/services text
- Information architecture and sections that the data actually supports
- Exact copy to use from the sheet (name, tagline, phones, email, address, hours, welcome, about, services, social links)
- Use all HTML files in public/references as the layout library. Make ${reference?.id || "classic"} the primary layout for this page. Keep the page bright and clinic-like: cream or white surfaces, pale hero, light footer, no black or slate-900 bands. Use Playfair Display or Plus Jakarta Sans for headings and Nunito, Poppins, or DM Sans for body. Do not reuse any sample clinic content. Use only the ${palette.family} palette from this brief. Do not fall back to teal unless this palette is teal.
- Include a logo or icon in the header only if a real clinic logo/icon file is listed in the resources (a Drive or sheet file named logo or icon). If no such file exists, show the clinic name only. Do not invent a logo, initials badge, Lucide brand icon, or generated SVG icon.
- Desktop and mobile menus must start with Home linking to #home. Put id="home" on the hero section.
- If a services list exists, build a services section with one card per service. Each card is title plus a short description only. Do not put an icon, Lucide mark, SVG, or image at the top of a service card.
- Social media: every social link must use a recognizable brand icon (Facebook, Instagram, YouTube, X/Twitter, LinkedIn, WhatsApp, TikTok). Do not show social URLs as plain text only. ${whatsappPromptGuide(clinic)}
- Contact area: create exactly ONE section with id="contact". Put address, phone, email, timing, map, and exactly one contact form (Name, Email, Address, Subject, Message) in that same section. Do not add a second contact block or a second Send a message form.
- Booking: if an online booking URL is provided, add a "Book an appointment" button/link that navigates to that URL on click. Use only the URL. Do not embed an iframe or widget code.
- Testimonials: if testimonials exist, plan exactly ONE section id="testimonials" as a horizontal swipe row. Each unique review becomes one card. Show the reviewer name on the card when a name is provided. Do not invent reviews, do not repeat a quote, and do not copy sample testimonials from reference pages.
- Where each resource file must be placed, using the exact file names above
- Responsive layout, accessibility, sticky header, and in-page navigation. Desktop and mobile menus must start with Home linking to #home.
- Phone CTA buttons in the header, hero, and mobile menu must show the word Contact, not the phone number. Keep href as tel: to the clinic number. Show the actual numbers only in the contact section and top utility bar.
- Map: use the provided Google Maps link only
- Do not invent clinic names, phones, emails, addresses, doctors, testimonials, or extra photos

Return ONLY the detailed website-generation prompt. No HTML. No markdown fences. No commentary.`;
}

function buildPagePrompt(plannedPrompt, images, serviceItems = [], clinic = {}, reviewData = { reviews: [] }, palette = COLOR_PALETTES[0], reference) {
  const srcList = images.map((image) => `"${image.fileName}"`).join(", ") || "none";
  const hasLogo = images.some((image) => image.role === "logo" && image.source !== "generated");
  const logoRule = hasLogo
    ? "This clinic has a real logo/icon file. Use that attached file in the header brand area only. Do not add a second icon beside it."
    : "This clinic has no logo or icon file. Header brand area must be the clinic name only. Do not add an img, Lucide icon, initials circle, plus icon, or any generated brand mark.";
  const bookingUrl = extractBookingUrl(clinic.bookingWidget);
  const serviceGuide = serviceItems.length
    ? serviceItems.map((service) => `- ${service}: title and short description only. No icon or image on this card.`).join("\n")
    : "- No services list was provided. Omit the services section.";
  const hasManual = formatManualTestimonialsForPrompt(clinic.manualTestimonials) !== "No manual testimonials were entered.";
  const wantsTestimonials = hasManual || wantsPaidExtraPages(clinic.extraPages);
  const reviewGuide = !wantsTestimonials
    ? "Do not add a testimonials section. No testimonials were entered and Extra pages was not purchased."
    : `${testimonialsPromptGuide(clinic, reviewData)} If the planner brief above already listed these same reviews, still output each quote only once. Do not reprint a review as both a featured quote and a card.`;

  return `${plannedPrompt}

Hard requirements for this generation:
- Return ONLY a full HTML document. No markdown. No explanation.
- Use every page in public/references. Follow ${reference?.id || "classic"} as the primary layout. Keep the page light and clinic-like: no black or slate-900 sections. Use clinic fonts (Playfair Display or Plus Jakarta for headings; Nunito, Poppins, or DM Sans for body). Recolor accents with ${palette.family} (${palette.deep}, ${palette.mid}, ${palette.bright}).
- Do not copy names, phones, emails, addresses, services, testimonials, or any other content from a sample/reference clinic. Use only the clinic data in this prompt.
- Include Tailwind and Lucide script tags. Call lucide.createIcons() after the markup. Extra embedded CSS is allowed for logo/gallery/testimonial tweaks.
- Use the attached brand resources. Reference images with these exact src values: ${srcList}
- Place each attached image in the role described in the brief. Do not leave attached images unused.
- ${logoRule}
- If there is a services section, each card is title and short description only. Do not add an icon, Lucide mark, SVG, or photo at the top of a service card.
- Services and visuals:
${serviceGuide}
- Give every social media link a brand icon. Keep the links working. ${whatsappPromptGuide(clinic)}
- There must be exactly one contact section (id="contact") and exactly one Send a message form. Show Email as its own labeled column when an email is provided${clinic.email ? `: ${clinic.email}` : ""}. That single form must include Name, Email, Address, Subject, and Message. Do not output two contact areas or two message forms.
- Phone CTA buttons (header chip, hero, mobile menu) must display the text Contact. Do not put the phone number on those buttons. Use tel: for the clinic number. Print numbers only in the contact section and top bar.
- ${bookingUrl ? `Add a "Book an appointment" button whose href is exactly ${bookingUrl}. On click, navigate to that URL (target _blank). Do not embed a booking iframe or paste widget HTML.` : "No booking URL was provided. Omit the Book an appointment button."}
- ${reviewGuide}
- The first desktop and mobile menu item must be Home, linking to #home. Give the hero/top section id="home".
- Use every attached Drive photo somewhere on the page (hero, about, or other fitting sections). Do not place Drive photos on top of service cards.
- ${wantsReadyPhotoGallery(clinic.photoGallery) ? "Photo gallery is Yes: add a Gallery menu link and a gallery section that shows ALL attached Drive photos, not only leftover images." : "Photo gallery is not Yes: do not add a gallery section or Gallery menu link. Still use Drive photos in hero, about, and services."}
- Do not invent clinic details.
- Do not use placeholder, stock, or generated fake photos except the custom SVG service and social icons described above.`;
}

function extractText(text) {
  const fenced = String(text || "").match(/```(?:markdown|text|prompt)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text || "").trim();
}

function addUsage(left, right) {
  return {
    promptTokens: (left.promptTokens || 0) + (right.promptTokens || 0),
    outputTokens: (left.outputTokens || 0) + (right.outputTokens || 0),
    totalTokens: (left.totalTokens || 0) + (right.totalTokens || 0)
  };
}

function wrapGeminiError(error) {
  const status = error.status || error.code;
  if (status === 429) {
    return new Error("Gemini rate limit reached. Wait a moment and try again.");
  }
  if (status === 401 || status === 403) {
    return new Error("Gemini API key is invalid or does not have access.");
  }
  return new Error(error.message || "Gemini failed to generate the page.");
}

function wrapClaudeError(error) {
  const status = error.status || error.code;
  if (status === 429) {
    return new Error("Claude rate limit reached. Wait a moment and try again.");
  }
  if (status === 401 || status === 403) {
    return new Error("Claude API key is invalid or does not have access.");
  }
  return new Error(error.message || "Claude failed to generate the page.");
}

function wrapChatGptError(error) {
  const status = error.status || error.code;
  if (status === 429) {
    return new Error("ChatGPT rate limit reached. Wait a moment and try again.");
  }
  if (status === 401 || status === 403) {
    return new Error("ChatGPT API key is invalid or does not have access.");
  }
  return new Error(error.message || "ChatGPT failed to generate the page.");
}

function wrapModelError(provider, error) {
  if (provider === "claude") {
    return wrapClaudeError(error);
  }
  return wrapGeminiError(error);
}

function providerLabel(provider) {
  if (provider === "claude") {
    return "Claude";
  }
  if (provider === "chatgpt") {
    return "ChatGPT (free)";
  }
  return "Gemini";
}

function toClaudeImageBlock(image) {
  if (!image?.dataUri || !CLAUDE_IMAGE_TYPES.has(image.mimeType)) {
    return null;
  }
  const comma = image.dataUri.indexOf(",");
  const data = comma >= 0 ? image.dataUri.slice(comma + 1) : "";
  if (!data) {
    return null;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mimeType,
      data
    }
  };
}

function extractClaudeText(payload) {
  return (payload.content || [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function generateContentWithRetry(contents, label = "page") {
  let lastError;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        console.log(`Generating ${label} with ${model} (attempt ${attempt})...`);
        return await gemini.models.generateContent({ model, contents });
      } catch (error) {
        lastError = error;
        const status = Number(error.status || error.code);
        const message = String(error.message || "").toLowerCase();
        const retryable = status === 503 || status === 429 || status === 500
          || /overloaded|unavailable|try again|temporar|rate limit|resource exhausted/.test(message);
        if (!retryable || attempt === MAX_ATTEMPTS) {
          break;
        }
        const delayMs = 2000 * (2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

async function generateClaudeWithRetry(content, label = "page") {
  const apiKey = await getAnthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it in Sheet settings or in the .env file.");
  }

  let lastError;
  const maxTokens = label === "page" ? 32000 : 8000;

  for (const model of CLAUDE_MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        console.log(`Generating ${label} with ${model} (attempt ${attempt})...`);
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content }]
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(payload.error?.message || `Claude request failed (${response.status}).`);
          error.status = response.status;
          throw error;
        }
        return {
          text: extractClaudeText(payload),
          usage: payload.usage || {}
        };
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

function toChatGptImageBlock(image) {
  if (!image?.dataUri || !CLAUDE_IMAGE_TYPES.has(image.mimeType)) {
    return null;
  }
  return {
    type: "image_url",
    image_url: { url: image.dataUri }
  };
}

function extractChatGptText(payload) {
  return (payload.choices || [])
    .map((choice) => choice.message?.content || "")
    .join("\n")
    .trim();
}

async function generateChatGptWithRetry(content, label = "page") {
  const apiKey = await getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Add it in Sheet settings or in the .env file.");
  }

  let lastError;
  const maxTokens = label === "page" ? 32000 : 8000;

  for (const model of CHATGPT_MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        console.log(`Generating ${label} with ${model} (attempt ${attempt})...`);
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            max_completion_tokens: maxTokens,
            messages: [{ role: "user", content }]
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(payload.error?.message || `ChatGPT request failed (${response.status}).`);
          error.status = response.status;
          throw error;
        }
        return {
          text: extractChatGptText(payload),
          usage: payload.usage || {}
        };
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

function injectBefore(html, pattern, snippet) {
  const match = html.match(pattern);
  if (!match) {
    return html;
  }
  return html.replace(match[0], `${match[0]}\n${snippet}`);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serviceIconGlyph(label, ink = "#1f5c4d") {
  const text = String(label || "").toLowerCase();
  const color = ink;
  if (/tooth|dental|denture|smile|oral|gum|scaling|whitening|canal|extract/.test(text)) {
    return `<path fill="${color}" d="M32 12c-7 0-12 6-12 14 0 10 4 22 8 28 2 3 6 3 8 0 4-6 8-18 8-28 0-8-5-14-12-14z"/>`;
  }
  if (/implant|crown|bridge/.test(text)) {
    return `<rect x="28" y="12" width="8" height="16" rx="2" fill="${color}"/><path fill="${color}" d="M22 30h20l-3 20H25z"/>`;
  }
  if (/brace|aligner|ortho/.test(text)) {
    return `<path fill="none" stroke="${color}" stroke-width="3" d="M18 28c4-8 24-8 28 0"/><path fill="none" stroke="${color}" stroke-width="3" d="M18 36c4 8 24 8 28 0"/><circle cx="24" cy="32" r="3" fill="${color}"/><circle cx="32" cy="32" r="3" fill="${color}"/><circle cx="40" cy="32" r="3" fill="${color}"/>`;
  }
  if (/child|pediatric|kid/.test(text)) {
    return `<circle cx="32" cy="20" r="8" fill="${color}"/><path fill="${color}" d="M18 50c2-12 26-12 28 0v2H18z"/>`;
  }
  if (/skin|derma|acne|hair|cosmo/.test(text)) {
    return `<circle cx="32" cy="32" r="14" fill="none" stroke="${color}" stroke-width="3"/><path fill="${color}" d="M32 14v6M32 44v6M14 32h6M44 32h6"/>`;
  }
  if (/eye|vision|opto|retina/.test(text)) {
    return `<path fill="none" stroke="${color}" stroke-width="3" d="M12 32c8-12 32-12 40 0-8 12-32 12-40 0z"/><circle cx="32" cy="32" r="6" fill="${color}"/>`;
  }
  if (/physio|rehab|pain|sport|therapy/.test(text)) {
    return `<circle cx="32" cy="14" r="5" fill="${color}"/><path fill="none" stroke="${color}" stroke-width="3" d="M32 20v16m0 0l-10 14m10-14l10 14M20 30h24"/>`;
  }
  if (/vet|animal|pet|dog|cat/.test(text)) {
    return `<circle cx="20" cy="22" r="6" fill="${color}"/><circle cx="44" cy="22" r="6" fill="${color}"/><circle cx="32" cy="36" r="12" fill="${color}"/>`;
  }
  if (/surg|operat/.test(text)) {
    return `<path fill="none" stroke="${color}" stroke-width="3" d="M20 44l24-24M26 18l4 4M38 42l4 4"/>`;
  }
  if (/x[- ]?ray|scan|radio/.test(text)) {
    return `<rect x="16" y="14" width="32" height="36" rx="4" fill="none" stroke="${color}" stroke-width="3"/><path stroke="${color}" stroke-width="3" d="M24 24h16M24 32h16M24 40h10"/>`;
  }
  if (/heart|cardio/.test(text)) {
    return `<path fill="${color}" d="M32 50s-16-10-16-22a10 10 0 0 1 16-8 10 10 0 0 1 16 8c0 12-16 22-16 22z"/>`;
  }
  if (/vaccine|immun|inject/.test(text)) {
    return `<rect x="36" y="12" width="8" height="14" rx="1" fill="${color}"/><path fill="${color}" d="M18 48l16-16 6 6-16 16z"/><path stroke="${color}" stroke-width="3" d="M40 18l8-8"/>`;
  }
  return `<rect x="28" y="14" width="8" height="36" rx="2" fill="${color}"/><rect x="14" y="28" width="36" height="8" rx="2" fill="${color}"/>`;
}

function serviceIconSvg(label, palette = COLOR_PALETTES[0]) {
  return `<svg class="service-tile-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56" role="img" aria-label="${escapeHtml(label)}"><rect width="64" height="64" rx="16" fill="${palette.deep}" fill-opacity="0.12"/>${serviceIconGlyph(label, palette.deep)}</svg>`;
}

function serviceVisualFor(service, images, palette = COLOR_PALETTES[0]) {
  const match = images.find((image) => image.matchedService === service)
    || images.find((image) => matchingServiceName(image.originalName, [service]));
  if (match?.dataUri) {
    return `<img class="service-tile-image" src="${match.dataUri}" alt="${escapeHtml(service)}">`;
  }
  return serviceIconSvg(service, palette);
}

function isServiceNavVisual(visual) {
  return /data-lucide=["'](arrow-right|arrow-left|arrow-up-right|chevron-right|chevron-left|plus)["']/i.test(visual);
}

function isServiceCardVisual(visual) {
  if (isServiceNavVisual(visual)) {
    return false;
  }
  return /service-tile-icon|service-tile-image|data-lucide|<svg\b|<img\b/i.test(visual);
}

function eachServiceVisual(html, onVisual) {
  return String(html || "").replace(
    /<i\b[^>]*data-lucide[\s\S]*?<\/i>|<svg\b[\s\S]*?<\/svg>|<img\b[^>]*>/gi,
    onVisual
  );
}

function serviceCardStart(html, headingIndex) {
  const start = Math.max(0, headingIndex - 1200);
  const before = html.slice(start, headingIndex);
  const articleAt = Math.max(before.lastIndexOf("<article"), before.lastIndexOf("<li"));
  if (articleAt >= 0) {
    return start + articleAt;
  }

  let best = -1;
  const opener = /<div\b[^>]*>/gi;
  let match;
  while ((match = opener.exec(before))) {
    const tag = match[0];
    if (/rounded|shadow|card|service|tile|bg-white|p-6|p-8|p-10/i.test(tag) && !/w-1[2-6]|h-1[2-6]|icon/i.test(tag)) {
      best = match.index;
    }
  }
  return best >= 0 ? start + best : Math.max(0, headingIndex - 400);
}

function headingAlreadyHasVisual(html, index) {
  const window = html.slice(serviceCardStart(html, index), index);
  let found = false;
  eachServiceVisual(window, (visual) => {
    if (isServiceCardVisual(visual)) {
      found = true;
    }
    return visual;
  });
  return found;
}

function stripExtraServiceVisuals(cardHtml) {
  const result = eachServiceVisual(cardHtml, (visual) => (
    isServiceCardVisual(visual) ? "" : visual
  ));
  return result
    .replace(/<div\b[^>]*(?:w-1[2-6]|h-1[2-6]|h-28|h-32|icon)[^>]*>\s*<\/div>/gi, "")
    .replace(/<div\b[^>]*>\s*<\/div>/gi, "");
}

function serviceSectionMatch(html) {
  return String(html || "").match(/<section\b[^>]*id=["']services["'][^>]*>[\s\S]*?<\/section>/i)
    || String(html || "").match(/<section\b[^>]*class=["'][^"']*service[^"']*["'][^>]*>[\s\S]*?<\/section>/i);
}

function serviceCardHeadingMatches(section) {
  const h3 = [...section.matchAll(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi)];
  if (h3.length) {
    return h3;
  }
  return [...section.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi)].slice(1);
}

function dedupeServiceCardVisuals(html) {
  const sectionMatch = serviceSectionMatch(html);
  if (!sectionMatch) {
    return html;
  }

  let section = sectionMatch[0];
  const headings = serviceCardHeadingMatches(section);
  if (!headings.length) {
    return html;
  }

  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    const headingIndex = heading.index;
    const windowStart = serviceCardStart(section, headingIndex);
    const windowEnd = headingIndex + heading[0].length;
    const cleaned = stripExtraServiceVisuals(section.slice(windowStart, windowEnd));
    section = `${section.slice(0, windowStart)}${cleaned}${section.slice(windowEnd)}`;
  }

  return html.replace(sectionMatch[0], section);
}

function replaceServiceCardVisual(cardHtml, visualHtml) {
  const stripped = eachServiceVisual(cardHtml, (visual) => (
    isServiceCardVisual(visual) ? "" : visual
  )).replace(/<div\b[^>]*(?:w-1[2-6]|h-1[2-6]|icon)[^>]*>\s*<\/div>/gi, "");
  if (/(<h[1-6]\b[^>]*>)/i.test(stripped)) {
    return stripped.replace(/(<h[1-6]\b[^>]*>)/i, `${visualHtml}$1`);
  }
  return `${visualHtml}${stripped}`;
}

function ensureServiceTileVisuals(html, serviceItems) {
  if (!serviceItems.length) {
    return html;
  }

  const sectionMatch = serviceSectionMatch(html);
  if (!sectionMatch) {
    return html;
  }

  let section = sectionMatch[0];
  const headings = serviceCardHeadingMatches(section);
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    const windowStart = serviceCardStart(section, heading.index);
    const windowEnd = heading.index + heading[0].length;
    const cleaned = stripExtraServiceVisuals(section.slice(windowStart, windowEnd));
    section = `${section.slice(0, windowStart)}${cleaned}${section.slice(windowEnd)}`;
  }

  return html.replace(sectionMatch[0], section);
}

function stripGallerySection(html) {
  let result = String(html || "");
  result = result.replace(/<section[^>]*id=["']gallery["'][^>]*>[\s\S]*?<\/section>/gi, "");
  result = result.replace(/<a\b[^>]*href=["']#gallery["'][^>]*>[\s\S]*?<\/a>/gi, "");
  return result;
}

function stripTestimonialsSection(html) {
  let result = String(html || "");
  result = result.replace(/<section[^>]*id=["']testimonials["'][^>]*>[\s\S]*?<\/section>/gi, "");
  result = result.replace(/<a\b[^>]*href=["']#testimonials["'][^>]*>[\s\S]*?<\/a>/gi, "");
  return result;
}

function embedImagesInHtml(html, images, serviceItems = [], wantsGallery = true, palette = COLOR_PALETTES[0]) {
  let result = html;

  for (const image of images) {
    result = result.split(`resource/${image.fileName}`).join(image.dataUri);
    result = result.split(image.fileName).join(image.dataUri);
  }

  for (const image of images) {
    if (result.includes(image.dataUri)) {
      continue;
    }

    const alt = `${image.role} image`;
    if (image.role === "logo") {
      if (image.source === "generated") {
        continue;
      }
      const tag = `<img src="${image.dataUri}" alt="${alt}" class="clinic-logo" style="height:64px;width:auto;">`;
      const withHeader = injectBefore(result, /<header[^>]*>/i, tag);
      result = withHeader === result
        ? result.replace(/<body[^>]*>/i, (open) => `${open}\n${tag}`)
        : withHeader;
      continue;
    }

    if (image.role === "banner") {
      const tag = `<section id="hero"><img src="${image.dataUri}" alt="${alt}" class="clinic-banner" style="width:100%;height:auto;display:block;"></section>`;
      const withHeaderClose = result.replace(/<\/header>/i, (close) => `${close}\n${tag}`);
      result = withHeaderClose === result
        ? result.replace(/<body[^>]*>/i, (open) => `${open}\n${tag}`)
        : withHeaderClose;
      continue;
    }

    if (image.role === "about") {
      const tag = `<img src="${image.dataUri}" alt="${alt}" class="clinic-about-image" style="max-width:100%;height:auto;">`;
      const withAbout = result.replace(/id=["']about["'][^>]*>/i, (open) => `${open}\n${tag}`);
      result = withAbout === result
        ? `${result}\n<section id="about">${tag}</section>`
        : withAbout;
    }
  }

  result = ensureServiceTileVisuals(result, serviceItems);
  result = dedupeServiceCardVisuals(result);

  const unused = images.filter((image) => image.source !== "generated" && image.source !== "figma" && !result.includes(image.dataUri));
  if (unused.length && !wantsGallery) {
    const extras = unused.map((image) => (
      `<img src="${image.dataUri}" alt="${escapeHtml(image.originalName || image.role)}" class="clinic-about-image" style="max-width:100%;height:auto;border-radius:16px;margin:12px 0;">`
    )).join("");
    result = /id=["']about["']/i.test(result)
      ? result.replace(/id=["']about["'][^>]*>/i, (open) => `${open}\n${extras}`)
      : `${result}\n<section id="about">${extras}</section>`;
  } else if (unused.length && wantsGallery) {
    const extras = unused.map((image) => (
      `<img src="${image.dataUri}" alt="${escapeHtml(image.originalName || image.role)}" class="clinic-drive-photo">`
    )).join("");
    if (/id=["']gallery["']/i.test(result)) {
      result = result.replace(/id=["']gallery["'][^>]*>/i, (open) => `${open}\n${extras}`);
    }
  }

  return result;
}

function drivePhotos(images) {
  return (images || []).filter((image) => image.source !== "generated" && image.dataUri);
}

function gallerySectionHtml(images) {
  const photos = drivePhotos(images).map((image) => (
    `<img src="${image.dataUri}" alt="${escapeHtml(image.originalName || image.role)}" class="clinic-drive-photo">`
  )).join("");
  return `<section id="gallery" class="clinic-drive-photos"><div class="clinic-drive-photos-wrap"><p class="clinic-drive-photos-kicker">From the clinic</p><h2>Photo gallery</h2><div class="clinic-drive-photos-grid">${photos}</div></div></section>`;
}

function insertBeforeContactOrFooter(html, block) {
  if (/<section[^>]*id=["']contact["']/i.test(html)) {
    return html.replace(/<section[^>]*id=["']contact["']/i, `${block}\n<section id="contact"`);
  }
  if (/<footer/i.test(html)) {
    return html.replace(/<footer/i, `${block}\n<footer`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}</body>`);
  }
  return `${html}\n${block}`;
}

function ensureGallerySection(html, images, wantsGallery) {
  if (!wantsGallery || !drivePhotos(images).length) {
    return stripGallerySection(html);
  }

  const section = gallerySectionHtml(images);
  if (/<section[^>]*id=["']gallery["']/i.test(html)) {
    return html.replace(/<section[^>]*id=["']gallery["'][^>]*>[\s\S]*?<\/section>/i, section);
  }
  return insertBeforeContactOrFooter(html, section);
}

function copyMenuLink(inner, href, label) {
  const match = String(inner || "").match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
  if (!match) {
    return `<a href="${href}">${label}</a>`;
  }
  let attrs = match[1].replace(/href=["'][^"']*["']/, `href="${href}"`);
  if (!/href=/i.test(attrs)) {
    attrs = `href="${href}" ${attrs}`;
  }
  return `<a ${attrs}>${label}</a>`;
}

function ensureHomeSection(html) {
  if (/id=["']home["']/i.test(html)) {
    return html;
  }
  if (/<section\b[^>]*id=["']hero["']/i.test(html)) {
    return html.replace(/<section(\s+)([^>]*id=["'])hero(["'][^>]*)>/i, "<section$1$2home$3>");
  }
  return html.replace(/<\/header>\s*<section\b([^>]*)>/i, (full, attrs) => {
    if (/id=/i.test(attrs)) {
      return `</header>\n<section${attrs.replace(/id=["'][^"']*["']/, 'id="home"')}>`;
    }
    return `</header>\n<section id="home"${attrs}>`;
  });
}

function insertMenuLink(html, href, label, { first = false, beforeHref = "#contact" } = {}) {
  const inject = (inner) => {
    if (new RegExp(`href=["']${href}["']`, "i").test(inner)) {
      return inner;
    }
    const link = copyMenuLink(inner, href, label);
    if (first && /<a\b/i.test(inner)) {
      return inner.replace(/<a\b/i, `${link}\n<a`);
    }
    const before = new RegExp(`<a\\b[^>]*href=["']${beforeHref}["'][^>]*>`, "i");
    if (before.test(inner)) {
      return inner.replace(before, `${link}\n$&`);
    }
    if (/<a\b/i.test(inner)) {
      return inner.replace(/(<a\b[^>]*>[\s\S]*?<\/a>)(?![\s\S]*<a\b)/i, `$1\n${link}`);
    }
    return `${inner}\n${link}`;
  };

  let result = html.replace(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi, (full, attrs, inner) => (
    `<nav${attrs}>${inject(inner)}</nav>`
  ));
  result = result.replace(/<(div|ul)([^>]*id=["'][^"']*mobile[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi, (full, tag, attrs, inner) => (
    `<${tag}${attrs}>${inject(inner)}</${tag}>`
  ));
  return result;
}

function ensureHomeMenu(html) {
  return insertMenuLink(ensureHomeSection(html), "#home", "Home", { first: true });
}

function ensureGalleryMenu(html, wantsGallery) {
  if (!wantsGallery) {
    return html.replace(/<a\b[^>]*href=["']#gallery["'][^>]*>[\s\S]*?<\/a>/gi, "");
  }
  return insertMenuLink(html, "#gallery", "Gallery", { beforeHref: "#contact" });
}

function socialNetworkFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("facebook") || host === "fb.com" || host.endsWith(".fb.com")) {
      return "facebook";
    }
    if (host.includes("instagram")) {
      return "instagram";
    }
    if (host === "x.com" || host.includes("twitter")) {
      return "twitter";
    }
    if (host.includes("youtube") || host === "youtu.be") {
      return "youtube";
    }
    if (host.includes("linkedin")) {
      return "linkedin";
    }
    if (host.includes("whatsapp") || host === "wa.me") {
      return "whatsapp";
    }
    if (host.includes("tiktok")) {
      return "tiktok";
    }
    if (host.includes("pinterest")) {
      return "pinterest";
    }
    return "";
  } catch {
    return "";
  }
}

function socialIconSvg(network) {
  const icons = {
    facebook: '<path fill="currentColor" d="M22 12.07C22 6.5 17.52 2 12 2S2 6.5 2 12.07C2 17.1 5.66 21.24 10.44 22v-7.01H7.9v-2.92h2.54V9.84c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.47h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.92h-2.34V22C18.34 21.24 22 17.1 22 12.07z"/>',
    instagram: '<path fill="currentColor" d="M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zm5 4.8A4.2 4.2 0 1 0 16.2 12 4.2 4.2 0 0 0 12 7.8zm6.35-.95a1.05 1.05 0 1 0 1.05 1.05 1.05 1.05 0 0 0-1.05-1.05zM12 9.2A2.8 2.8 0 1 1 9.2 12 2.8 2.8 0 0 1 12 9.2z"/>',
    twitter: '<path fill="currentColor" d="M18.2 3H21l-6.5 7.43L22 21h-5.6l-4.38-5.72L6.7 21H4l7-8-6.7-10h5.7l4 5.26L18.2 3zm-1 16.2h1.6L6.9 4.7H5.2l12 14.5z"/>',
    youtube: '<path fill="currentColor" d="M21.6 7.2a3 3 0 0 0-2.1-2.1C17.7 4.7 12 4.7 12 4.7s-5.7 0-7.5.4a3 3 0 0 0-2.1 2.1C2 9 2 12 2 12s0 3 .4 4.8a3 3 0 0 0 2.1 2.1c1.8.4 7.5.4 7.5.4s5.7 0 7.5-.4a3 3 0 0 0 2.1-2.1C22 15 22 12 22 12s0-3-.4-4.8zM10 15.5v-7l6 3.5-6 3.5z"/>',
    linkedin: '<path fill="currentColor" d="M6.5 9H4V20h2.5V9zM5.2 4A1.6 1.6 0 1 0 5.2 7.2 1.6 1.6 0 0 0 5.2 4zM20 20h-2.5v-5.4c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9V20H11V9h2.4v1.5h.1A2.6 2.6 0 0 1 16 9c2.8 0 4 1.9 4 4.6V20z"/>',
    whatsapp: '<path fill="currentColor" d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3zm5 12.2c-.2.6-1.2 1.1-1.7 1.1-.4 0-.9.2-3.1-.7-2.6-1.1-4.3-3.7-4.4-3.9s-1.1-1.5-1.1-2.8.7-2 1-2.2.4-.3.6-.3h.4c.2 0 .4 0 .5.4l.7 1.7c.1.2 0 .4-.1.5l-.3.4c-.1.2-.3.3-.1.6s.8 1.3 1.7 2.1c1.2 1 2.2 1.3 2.5 1.5s.4 0 .5-.2l.6-.7.5-.2.8.4c.3.2 1 .5 1.2.6s.3.2.4.3 0 .8-.2 1.4z"/>',
    tiktok: '<path fill="currentColor" d="M14 4h2.2a5.8 5.8 0 0 0 4 3.7V10a8 8 0 0 1-4-1.2V15a6.5 6.5 0 1 1-6.5-6.5h.5V11a4 4 0 1 0 2.8 3.8V4z"/>',
    pinterest: '<path fill="currentColor" d="M12 3a9 9 0 0 0-3.3 17.4c-.1-.7-.2-1.8 0-2.6l1.8-7.6s-.5-1-.5-2.3 1-2.1 2.1-2.1 1 1 1 2-1.3 3.2-1.3 3.2 1.1 2.2 2.6 2.2 3.9-2.3 3.9-5.6-2.6-4.7-5.9-4.7-6.2 3.3-6.2 6.7c0 1.2.7 2.7 1.6 3.2a.3.3 0 0 0 .4 0c.1-.3.3-1 .3-1.3s-.5-1.4-.5-2.3.9-1.8 2-1.8 1.7 1.2 1.7 2.9-.7 3.4-1.1 4.6l-.5 1.8c-.3 1.1.2 2.4.3 2.6A9 9 0 1 0 12 3z"/>'
  };
  const path = icons[network] || icons.facebook;
  return `<svg class="social-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${path}</svg>`;
}

function clinicFontMarkup() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;600;700&family=Nunito:wght@400;600;700&family=Playfair+Display:ital,wght@0,500;0,700;1,500&family=Plus+Jakarta+Sans:wght@600;700;800&family=Poppins:wght@600;700;800&family=Source+Sans+3:wght@400;600;700&display=swap">
<style id="clinic-fonts">body{font-family:Nunito,"Source Sans 3","DM Sans",Poppins,sans-serif}h1,h2,h3{font-family:"Playfair Display","Plus Jakarta Sans",Poppins,serif}</style>`;
}

function ensureClinicFonts(html) {
  if (/id=["']clinic-fonts["']/.test(html) || (/Playfair\+Display/.test(html) && /Nunito/.test(html))) {
    return html;
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", `${clinicFontMarkup()}</head>`);
  }
  return `${clinicFontMarkup()}${html}`;
}

function pageFixStyles(palette = COLOR_PALETTES[0]) {
  return `<style id="clinic-page-fixes">
body{background:#fffefb;color:#334155;font-family:Nunito,"Source Sans 3","DM Sans",sans-serif}
h1,h2,h3{font-family:"Playfair Display","Plus Jakarta Sans",Poppins,serif;letter-spacing:-.02em;color:#0f172a}
#home,#hero{background:linear-gradient(160deg,${palette.wash} 0%,#ffffff 48%,${palette.pale} 100%);color:#0f172a}
#home.text-white,#hero.text-white{color:#0f172a}
#home .text-white:not([class*="bg-"]),#hero .text-white:not([class*="bg-"]){color:#1e293b}
#home .text-slate-300,#hero .text-slate-300,#home .text-slate-200,#hero .text-slate-200{color:#475569}
footer{background:${palette.wash};color:#334155}
footer .text-white{color:#0f172a}
.social-links{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.social-link{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:999px;background:${palette.deep};color:#fff;text-decoration:none}
.social-link span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.booking-btn,.contact-btn,a[class*="btn"],button[class*="btn"],header a[href^="tel:"],#home a[href^="tel:"],#hero a[href^="tel:"],form button[type="submit"],.clinic-contact-form button{display:inline-flex!important;flex-direction:row!important;align-items:center!important;justify-content:center!important;text-align:center!important;line-height:1.2!important;white-space:nowrap;vertical-align:middle}
.booking-btn{padding:14px 22px;border-radius:12px;background:${palette.mid};color:${palette.ink};text-decoration:none;font-weight:700}
.contact-btn{gap:8px;padding:12px 20px;border-radius:12px;background:${palette.deep};color:#fff;text-decoration:none;font-weight:700}
.contact-btn-label{display:inline-flex;align-items:center;justify-content:center;gap:8px;line-height:1}
.booking-btn svg,.contact-btn svg,.contact-btn-label svg,a[class*="btn"] svg,button[class*="btn"] svg,form button svg{width:1em;height:1em;flex-shrink:0;display:block}
.contact-email{display:flex;align-items:flex-start;gap:14px;max-width:36rem;margin:0 0 20px;padding:18px 20px;border:1px solid #e2e8f0;border-radius:16px;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.04)}
.contact-email-icon{width:44px;height:44px;border-radius:12px;background:${palette.pale};color:${palette.deep};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.contact-email .contact-label{display:block;margin:0 0 4px;font-size:.82rem;letter-spacing:.02em;text-transform:none;color:#0f172a;font-weight:700}
.contact-email a{display:block;color:#475569;font-weight:600;text-decoration:none;word-break:break-all;line-height:1.5}
.contact-email a:hover{color:${palette.deep}}
.contact-item{margin:8px 0}
.clinic-contact-form{margin-top:28px;padding:28px;border:1px solid #e2e8f0;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.05);max-width:40rem}
.clinic-contact-form h3{margin:0 0 18px;color:#0f172a;font-size:1.25rem}
.clinic-contact-form label{display:block;margin:0 0 14px;font-size:.82rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${palette.deep}}
.clinic-contact-form input,.clinic-contact-form textarea{display:block;width:100%;margin-top:6px;padding:12px 14px;border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc;color:#0f172a;font:inherit;text-transform:none;letter-spacing:0;font-weight:400}
.clinic-contact-form textarea{min-height:140px;resize:vertical}
.clinic-contact-form button{margin-top:8px;padding:12px 20px;border:0;border-radius:12px;background:${palette.deep};color:#fff;font-weight:700;cursor:pointer;width:100%}
#testimonials{padding:80px 5%;background:#f1f5f9}
.testimonials-wrap{max-width:80rem;margin:0 auto}
.testimonials-head{display:flex;justify-content:space-between;gap:16px;align-items:end;flex-wrap:wrap;margin-bottom:36px}
.testimonials-kicker{display:inline-flex;margin:0 0 10px;padding:6px 12px;border-radius:999px;background:${palette.pale};color:${palette.deep};font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.testimonials-head h2{margin:0;font-size:2rem;color:#0f172a}
.testimonials-head .muted{margin:8px 0 0;color:#64748b}
.testimonials-more{color:${palette.deep};font-weight:700;text-decoration:none}
.testimonials-scroller{display:flex;gap:20px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding:4px 2px 18px;cursor:grab}
.testimonials-scroller.is-dragging{cursor:grabbing}
.testimonial-card{position:relative;flex:0 0 min(86vw,340px);padding:32px 28px 28px;border:1px solid #e2e8f0;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.05);scroll-snap-align:start}
.testimonial-quote{position:absolute;top:16px;right:20px;color:${palette.quote};font-size:3rem;line-height:1;font-family:Georgia,serif}
.testimonial-stars{margin:0 0 12px;color:${palette.bright};letter-spacing:2px}
.testimonial-card blockquote{margin:0 0 20px;color:#334155;line-height:1.6;font-size:1rem}
.testimonial-meta{display:flex;align-items:center;gap:12px}
.testimonial-avatar{width:40px;height:40px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;background:${palette.deep};color:${palette.onDeep};font-weight:800;font-size:.85rem}
.testimonial-author{margin:0;font-weight:700;color:#0f172a}
.testimonial-time{margin:4px 0 0;color:#64748b;font-size:.85rem}
#services article,#services [class*="rounded-3xl"],#services [class*="rounded-2xl"]{background:#fff;border:1px solid #e2e8f0;border-top:3px solid ${palette.mid};border-radius:20px;padding:28px 24px 26px;box-shadow:0 10px 28px rgba(15,23,42,.05)}
#services article h3,#services [class*="rounded-3xl"] h3,#services [class*="rounded-2xl"] h3{margin:0 0 10px;font-size:1.15rem;line-height:1.35;color:#0f172a}
#services article p,#services [class*="rounded-3xl"] p,#services [class*="rounded-2xl"] p{margin:0;color:#64748b;line-height:1.65}
#services .service-tile-icon,#services .service-tile-image{display:none!important}
#services article>div:first-child:not(:has(h2)):not(:has(h3)):not(:has(p)){display:none!important}
.clinic-drive-photos{padding:80px 5%;background:#fff}
.clinic-drive-photos-wrap{max-width:80rem;margin:0 auto}
.clinic-drive-photos-kicker{display:inline-flex;margin:0 0 10px;padding:6px 12px;border-radius:999px;background:${palette.pale};color:${palette.deep};font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.clinic-drive-photos h2{margin:0 0 28px;font-size:2rem;color:#0f172a}
.clinic-drive-photos-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.clinic-drive-photo{width:100%;height:220px;object-fit:cover;border-radius:16px;display:block;background:${palette.wash}}
</style>`;
}

function ensurePageFixStyles(html, palette = COLOR_PALETTES[0]) {
  if (html.includes("id=\"clinic-page-fixes\"")) {
    return html;
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", `${pageFixStyles(palette)}</head>`);
  }
  return `${pageFixStyles(palette)}${html}`;
}

function replaceAnchor(html, hrefPattern, builder) {
  return html.replace(/<a\b([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, href, inner) => {
    if (!hrefPattern.test(href)) {
      hrefPattern.lastIndex = 0;
      return full;
    }
    hrefPattern.lastIndex = 0;
    return builder(full, attrs, href, inner);
  });
}

function ensureSocialIcons(html, socialLinks) {
  let result = html;
  result = replaceAnchor(result, /^https?:\/\//i, (full, attrs, href, inner) => {
    const network = socialNetworkFromUrl(href);
    if (!network) {
      return full;
    }
    if (/<svg|<img/i.test(inner)) {
      return full;
    }
    const labeled = /aria-label=/i.test(attrs) ? attrs : `${attrs} aria-label="${network}"`;
    const classed = /class=/i.test(labeled)
      ? labeled.replace(/class=["']([^"']*)["']/, (match, value) => `class="${value} social-link"`)
      : `${labeled} class="social-link"`;
    return `<a ${classed}>${socialIconSvg(network)}<span>${inner.trim() || network}</span></a>`;
  });

  const missing = extractUrls(socialLinks).filter((url) => socialNetworkFromUrl(url) && !result.includes(url));
  if (!missing.length) {
    return result;
  }

  const links = missing.map((url) => {
    const network = socialNetworkFromUrl(url);
    return `<a class="social-link" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="${network}">${socialIconSvg(network)}<span>${network}</span></a>`;
  }).join("");
  const block = `<div class="social-links">${links}</div>`;

  if (/<\/footer>/i.test(result)) {
    return result.replace(/<\/footer>/i, `${block}</footer>`);
  }
  if (/id=["']contact["']/i.test(result)) {
    return result.replace(/id=["']contact["'][^>]*>/i, (open) => `${open}\n${block}`);
  }
  if (/<\/body>/i.test(result)) {
    return result.replace(/<\/body>/i, `${block}</body>`);
  }
  return `${result}\n${block}`;
}

function isBookingControlText(text) {
  const value = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return /book(?:ing)?(?:\s+an)?\s+appoint/i.test(value)
    || /book\s+now/i.test(value)
    || /^book$/i.test(value);
}

function ensureBookingButton(html, bookingUrl) {
  if (!bookingUrl) {
    return html.replace(/<iframe\b[^>]*(booking|appoint|calendly|setmore|simplybook|widget)[^>]*>[\s\S]*?<\/iframe>/gi, "");
  }

  let result = html.replace(/<iframe\b[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>/gi, (full, src) => {
    if (/google\.com\/maps|maps\.google|maps\.app/i.test(src)) {
      return full;
    }
    if (src.includes(bookingUrl) || /book|appoint|calendly|setmore|simplybook|widget/i.test(full)) {
      return "";
    }
    return full;
  });

  let found = false;
  result = result.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
    if (!isBookingControlText(inner) && !/booking-btn/i.test(attrs)) {
      return full;
    }
    found = true;
    const withoutHref = attrs.replace(/href=["'][^"']*["']/i, "").trim();
    const classed = /class=/i.test(withoutHref)
      ? withoutHref.replace(/class=["']([^"']*)["']/, (match, value) => `class="${value} booking-btn"`)
      : `${withoutHref} class="booking-btn"`;
    return `<a href="${bookingUrl}" target="_blank" rel="noopener noreferrer" ${classed}>${inner.trim() || "Book an appointment"}</a>`;
  });

  result = result.replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi, (full, attrs, inner) => {
    if (!isBookingControlText(inner)) {
      return full;
    }
    found = true;
    return `<a href="${bookingUrl}" target="_blank" rel="noopener noreferrer" class="booking-btn">${inner.trim() || "Book an appointment"}</a>`;
  });

  if (found) {
    return result;
  }

  const button = `<a class="booking-btn" href="${bookingUrl}" target="_blank" rel="noopener noreferrer">Book an appointment</a>`;
  if (/<\/header>/i.test(result)) {
    return result.replace(/<\/header>/i, `${button}</header>`);
  }
  if (/<body[^>]*>/i.test(result)) {
    return result.replace(/<body[^>]*>/i, (open) => `${open}\n${button}`);
  }
  return `${button}\n${result}`;
}

function isMessageForm(form) {
  const html = String(form || "");
  return /<textarea\b/i.test(html)
    && (/type=["']email["']/i.test(html) || /name=["'][^"']*email/i.test(html));
}

function hasContactForm(html) {
  return (String(html || "").match(/<form\b[\s\S]*?<\/form>/gi) || []).some(isMessageForm);
}

function keepOneContactForm(inner) {
  const forms = String(inner || "").match(/<form\b[\s\S]*?<\/form>/gi) || [];
  if (forms.length <= 1) {
    return inner;
  }

  let keepIndex = forms.findIndex((form) => isMessageForm(form) && !/clinic-contact-form/i.test(form));
  if (keepIndex < 0) {
    keepIndex = forms.findIndex(isMessageForm);
  }
  if (keepIndex < 0) {
    keepIndex = 0;
  }

  let index = -1;
  return inner.replace(/<form\b[\s\S]*?<\/form>/gi, (form) => {
    index += 1;
    return index === keepIndex ? form : "";
  }).replace(/<h[1-4][^>]*>\s*send(?:\s+us)?(?:\s+a)?\s+message\s*<\/h[1-4]>\s*(?=<form|<h[1-4]|<\/|$)/gi, "");
}

function dedupeContactForms(html) {
  return String(html || "").replace(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi, (full, attrs, inner) => {
    if (!isContactLikeSection(attrs, inner) && !/id=["']contact["']/i.test(attrs)) {
      return full;
    }
    return `<section${attrs}>${keepOneContactForm(inner)}</section>`;
  });
}

function isContactSectionAttrs(attrs) {
  if (/id=["'](contact|get-in-touch|contact-us|reach-us|enquire|inquiry)["']/i.test(attrs)) {
    return true;
  }
  if (/contact-btn|contact-form|contact-item|contact-label|contact-email/i.test(attrs)) {
    return false;
  }
  return /class=["'][^"']*\bcontact(?:-section|-area|-info|-block|-wrap)?\b/i.test(attrs);
}

function isContactLikeSection(attrs, inner) {
  if (isContactSectionAttrs(attrs)) {
    return true;
  }
  return /<(h[1-3])[^>]*>\s*(contact(?:\s+us)?|get in touch|reach us|enquire|inquiry|send (?:a )?message)\s*</i.test(inner);
}

function collectContactSections(html) {
  const sections = [];
  const re = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
  let match;
  while ((match = re.exec(html))) {
    if (isContactLikeSection(match[1], match[2])) {
      sections.push({
        full: match[0],
        attrs: match[1],
        inner: match[2],
        index: match.index
      });
    }
  }
  return sections;
}

function scoreContactSection(inner) {
  let score = String(inner || "").length;
  if (hasContactForm(inner)) {
    score += 5000;
  }
  if (/mailto:/i.test(inner)) {
    score += 200;
  }
  if (/tel:/i.test(inner)) {
    score += 200;
  }
  if (/maps\.google|google\.com\/maps|maps\.app/i.test(inner)) {
    score += 300;
  }
  return score;
}

function withContactId(attrs) {
  if (/id=["']contact["']/i.test(attrs)) {
    return attrs;
  }
  if (/id=/i.test(attrs)) {
    return attrs.replace(/id=["'][^"']*["']/, 'id="contact"');
  }
  return `${attrs} id="contact"`;
}

function dedupeContactSections(html) {
  const sections = collectContactSections(html);
  if (!sections.length) {
    return html;
  }

  const preferred = [...sections].sort((left, right) => scoreContactSection(right.inner) - scoreContactSection(left.inner))[0];
  let inner = keepOneContactForm(preferred.inner);
  if (!hasContactForm(inner)) {
    const formSection = sections.find((section) => hasContactForm(section.inner));
    const form = (formSection?.inner.match(/<form\b[\s\S]*?<\/form>/gi) || []).find(isMessageForm);
    if (form) {
      inner += `\n${form}`;
    }
  }
  inner = keepOneContactForm(inner);

  const kept = `<section${withContactId(preferred.attrs)}>${inner}</section>`;
  let result = html;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    const end = section.index + section.full.length;
    result = `${result.slice(0, section.index)}${section === preferred ? kept : ""}${result.slice(end)}`;
  }

  let sawContactNav = false;
  return result.replace(/<a\b([^>]*href=["']#contact["'][^>]*)>([\s\S]*?)<\/a>/gi, (full) => {
    if (sawContactNav) {
      return "";
    }
    sawContactNav = true;
    return full;
  });
}

function firstContactOpenTag(html) {
  const section = collectContactSections(html)[0];
  if (section) {
    return section.full.match(/^<section\b[^>]*>/i)?.[0] || "";
  }
  return html.match(/<(section|div|address)[^>]*id=["']contact["'][^>]*>/i)?.[0] || "";
}

function contactFormHtml(clinic) {
  const email = String(clinic.email || "").trim();
  const action = email ? `mailto:${escapeHtml(email)}` : "#contact-form";
  return `<form id="contact-form" class="clinic-contact-form" action="${action}" method="post" enctype="text/plain">
<h3>Send a message</h3>
<label for="contact-name">Name<input id="contact-name" name="name" type="text" autocomplete="name" required></label>
<label for="contact-email">Email<input id="contact-email" name="email" type="email" autocomplete="email" required></label>
<label for="contact-address">Address<input id="contact-address" name="address" type="text" autocomplete="street-address"></label>
<label for="contact-subject">Subject<input id="contact-subject" name="subject" type="text" required></label>
<label for="contact-message">Message<textarea id="contact-message" name="message" required></textarea></label>
<button type="submit">Send message</button>
</form>`;
}

function ensureContactForm(html, clinic) {
  if (hasContactForm(html) || collectContactSections(html).some((section) => /<form\b/i.test(section.inner))) {
    return html;
  }

  const form = contactFormHtml(clinic);
  const contact = collectContactSections(html).sort((left, right) => scoreContactSection(right.inner) - scoreContactSection(left.inner))[0];
  if (contact) {
    return html.replace(contact.full, `<section${withContactId(contact.attrs)}>${contact.inner}\n${form}\n</section>`);
  }

  const block = `<section id="contact">${form}</section>`;
  if (/<footer/i.test(html)) {
    return html.replace(/<footer/i, `${block}\n<footer`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}</body>`);
  }
  return `${html}\n${block}`;
}

function contactEmailRow(email) {
  return `<div class="contact-item contact-email">
<span class="contact-email-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg></span>
<div><span class="contact-label">Email address</span><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></div>
</div>`;
}

function contactAlreadyShowsEmail(html, email) {
  const page = String(html || "").toLowerCase();
  const mail = String(email || "").trim().toLowerCase();
  if (!mail) {
    return true;
  }
  if (page.includes(`mailto:${mail}`) || page.includes(mail)) {
    return /e-?mail/i.test(html);
  }
  return false;
}

function insertEmailIntoContactInner(inner, row) {
  const card = String(inner || "").match(/<(article|div|ul|dl)([^>]*)>([\s\S]*?(?:tel:|address|map-pin|phone)[\s\S]*?)<\/\1>/i);
  if (card && !/<form\b/i.test(card[0])) {
    const updated = card[0].replace(/<\/(article|div|ul|dl)>$/i, `${row}</$1>`);
    return inner.replace(card[0], updated);
  }
  if (/<form\b/i.test(inner)) {
    return inner.replace(/<form\b/i, `${row}\n<form`);
  }
  return `${inner}\n${row}`;
}

function ensureEmailInContact(html, email) {
  if (!email || contactAlreadyShowsEmail(html, email)) {
    return html;
  }

  const row = contactEmailRow(email);
  const contact = collectContactSections(html).sort((left, right) => scoreContactSection(right.inner) - scoreContactSection(left.inner))[0];
  if (contact) {
    const inner = insertEmailIntoContactInner(contact.inner, row);
    return html.replace(contact.full, `<section${withContactId(contact.attrs)}>${inner}</section>`);
  }

  const block = `<section id="contact">${row}</section>`;
  if (/<footer/i.test(html)) {
    return html.replace(/<footer/i, `${block}\n<footer`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}</body>`);
  }
  return `${html}\n${block}`;
}

function starRating(rating) {
  const value = Math.max(1, Math.min(5, Number(rating) || 5));
  return `${"★".repeat(value)}${"☆".repeat(5 - value)}`;
}

function reviewInitials(name) {
  const words = String(name || "Patient")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return "P";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function isPhoneCta(attrs, inner) {
  const className = `${attrs} ${inner}`;
  return /btn|button|rounded-(?:xl|2xl|full)|px-\d|py-\d|bg-(?:teal|white)|shadow|inline-flex|contact-btn/i.test(className);
}

function contactButtonInner() {
  return `<span class="contact-btn-label"><i data-lucide="phone-call"></i><span>Contact</span></span>`;
}

function ensureLucideScripts(html) {
  let result = String(html || "");
  if (!/unpkg\.com\/lucide|jsdelivr\.net\/npm\/lucide|lucide@latest|lucide\.min\.js/i.test(result)) {
    const tag = `<script src="https://unpkg.com/lucide@latest"></script>`;
    result = result.includes("</head>") ? result.replace("</head>", `${tag}</head>`) : `${tag}${result}`;
  }
  result = result.replace(/lucide\.createIcons\(\)\s*;?/g, "");
  if (/id=["']clinic-lucide-init["']/.test(result)) {
    return result;
  }
  const init = `<script id="clinic-lucide-init">
document.addEventListener("DOMContentLoaded",function(){
  function run(){ if(window.lucide&&typeof lucide.createIcons==="function"){ lucide.createIcons(); } }
  if(window.lucide){ run(); return; }
  var n=0,t=setInterval(function(){ n+=1; if(window.lucide||n>50){ clearInterval(t); run(); } },100);
});
</script>`;
  if (/<\/body>/i.test(result)) {
    return result.replace(/<\/body>/i, `${init}</body>`);
  }
  return `${result}\n${init}`;
}

function ensureContactPhoneButtons(html) {
  return html.replace(/<a\b([^>]*href=["']tel:[^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
    const inContactBlock = /id=["']contact["']|contact information|contact numbers/i.test(full);
    if (inContactBlock) {
      return full;
    }
    if (!isPhoneCta(attrs, inner)) {
      return full;
    }
    const classed = /class=/i.test(attrs)
      ? attrs.replace(/class=["']([^"']*)["']/, (match, value) => `class="${value} contact-btn"`)
      : `${attrs} class="contact-btn"`;
    return `<a ${classed}>${contactButtonInner()}</a>`;
  });
}

function testimonialsSectionHtml(reviewData) {
  const cards = reviewData.reviews.map((review) => {
    const author = String(review.author || "").trim();
    const meta = author
      ? `<div class="testimonial-meta"><span class="testimonial-avatar">${escapeHtml(reviewInitials(author))}</span><div><p class="testimonial-author">${escapeHtml(author)}</p>${review.relativeTime ? `<p class="testimonial-time">${escapeHtml(review.relativeTime)}</p>` : ""}</div></div>`
      : "";
    return `<article class="testimonial-card"><span class="testimonial-quote" aria-hidden="true">“</span>${review.rating ? `<p class="testimonial-stars" aria-label="${review.rating} out of 5">${starRating(review.rating)}</p>` : ""}<blockquote>${escapeHtml(review.text)}</blockquote>${meta}</article>`;
  }).join("");
  const ratingLine = reviewData.rating
    ? `<p class="muted">${escapeHtml(String(reviewData.rating))}/5${reviewData.total ? ` from ${reviewData.total} Google reviews` : ""}</p>`
    : "";
  const moreLink = reviewData.mapsUrl
    ? `<a class="testimonials-more" href="${escapeHtml(reviewData.mapsUrl)}" target="_blank" rel="noopener noreferrer">See reviews on Google</a>`
    : "";

  return `<section id="testimonials"><div class="testimonials-wrap"><div class="testimonials-head"><div><p class="testimonials-kicker">Patient stories</p><h2>Testimonials</h2>${ratingLine}</div>${moreLink}</div><div class="testimonials-scroller" tabindex="0">${cards}</div></div></section>`;
}

function testimonialsSwipeScript() {
  return `<script id="clinic-testimonials-swipe">
(function(){
  var scroller=document.querySelector(".testimonials-scroller");
  if(!scroller){return;}
  var down=false,startX=0,startLeft=0;
  scroller.addEventListener("pointerdown",function(e){
    down=true;startX=e.clientX;startLeft=scroller.scrollLeft;scroller.classList.add("is-dragging");
    try{scroller.setPointerCapture(e.pointerId);}catch(err){}
  });
  scroller.addEventListener("pointermove",function(e){
    if(!down){return;}
    scroller.scrollLeft=startLeft-(e.clientX-startX);
  });
  function stopDrag(){down=false;scroller.classList.remove("is-dragging");}
  scroller.addEventListener("pointerup",stopDrag);
  scroller.addEventListener("pointercancel",stopDrag);
})();
</script>`;
}

function ensureTestimonialsSwipe(html) {
  let result = String(html || "").replace(/class=["'][^"']*testimonials-grid[^"']*["']/gi, 'class="testimonials-scroller"');
  if (!/testimonials-scroller/.test(result) || result.includes("id=\"clinic-testimonials-swipe\"")) {
    return result;
  }
  if (/<\/body>/i.test(result)) {
    return result.replace(/<\/body>/i, `${testimonialsSwipeScript()}</body>`);
  }
  return `${result}\n${testimonialsSwipeScript()}`;
}

function ensureWhatsAppSocial(html, clinic = {}) {
  const url = clinicWhatsAppUrl(clinic);
  if (!url) {
    return html;
  }
  if (/wa\.me\/|api\.whatsapp\.com|whatsapp\.com\/send/i.test(html)) {
    return html;
  }

  const icon = `<a class="social-link" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="whatsapp">${socialIconSvg("whatsapp")}<span>whatsapp</span></a>`;
  if (/<div[^>]*class=["'][^"']*social-links[^"']*["'][^>]*>/i.test(html)) {
    return html.replace(/<div[^>]*class=["'][^"']*social-links[^"']*["'][^>]*>/i, (open) => `${open}${icon}`);
  }
  if (/<\/footer>/i.test(html)) {
    return html.replace(/<\/footer>/i, `<div class="social-links">${icon}</div></footer>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `<div class="social-links">${icon}</div></body>`);
  }
  return `${html}\n<div class="social-links">${icon}</div>`;
}

function ensureTestimonials(html, reviewData, wantsTestimonials = true) {
  if (!wantsTestimonials) {
    return stripTestimonialsSection(html);
  }
  if (!reviewData?.reviews?.length) {
    return html;
  }
  if (/<section[^>]*id=["']testimonials["']/i.test(html)) {
    return html;
  }

  const section = testimonialsSectionHtml(reviewData);
  const stripped = html.replace(/<section[^>]*id=["']testimonials["'][^>]*>[\s\S]*?<\/section>/i, "");
  if (/<section[^>]*id=["']contact["']/i.test(stripped)) {
    return stripped.replace(/<section[^>]*id=["']contact["']/i, `${section}\n<section id="contact"`);
  }
  if (/<footer/i.test(stripped)) {
    return stripped.replace(/<footer/i, `${section}\n<footer`);
  }
  if (/<\/body>/i.test(stripped)) {
    return stripped.replace(/<\/body>/i, `${section}</body>`);
  }
  return `${stripped}\n${section}`;
}

function hasRealClinicIcon(images = []) {
  return images.some((image) => image.role === "logo" && image.source !== "generated" && image.dataUri);
}

function stripInventedClinicIcon(html, images = []) {
  if (hasRealClinicIcon(images)) {
    return html;
  }

  let result = String(html || "");
  result = result.replace(/<img\b[^>]*(?:class=["'][^"']*clinic-logo[^"']*["']|alt=["'][^"']*logo[^"']*["']|src=["'][^"']*logo\.(?:svg|png|jpe?g|webp)[^"']*["'])[^>]*>/gi, "");
  result = result.replace(/<header\b[\s\S]*?<\/header>/i, (header) => (
    header
      .replace(/<i\b[^>]*data-lucide=["'](?:stethoscope|heart-pulse|plus|plus-circle|activity|cross|hospital|building-2|shield-plus|heart)["'][^>]*>\s*<\/i>/gi, "")
      .replace(/<div\b[^>]*(?:w-8|w-9|w-10|w-12|h-8|h-9|h-10|h-12)[^>]*>\s*(?:<svg\b[\s\S]*?<\/svg>)?\s*<\/div>/gi, (box) => (
        /<svg\b|data-lucide/i.test(box) ? "" : box
      ))
  ));
  return result;
}

function applyPageFixes(html, clinic, reviewData = { reviews: [] }, palette = COLOR_PALETTES[0], images = []) {
  const bookingUrl = extractBookingUrl(clinic.bookingWidget);
  const wantsGallery = wantsReadyPhotoGallery(clinic.photoGallery);
  let result = ensureClinicFonts(html);
  result = stripInventedClinicIcon(result, images);
  result = ensurePageFixStyles(result, palette);
  result = ensureLucideScripts(result);
  result = ensureSocialIcons(result, clinic.socialLinks);
  result = ensureWhatsAppSocial(result, clinic);
  result = ensureBookingButton(result, bookingUrl);
  result = ensureContactPhoneButtons(result);
  result = dedupeContactSections(result);
  result = ensureEmailInContact(result, clinic.email);
  result = ensureContactForm(result, clinic);
  result = dedupeContactSections(result);
  result = dedupeContactForms(result);
  result = ensureTestimonials(result, reviewData, Boolean(reviewData?.reviews?.length));
  result = ensureTestimonialsSwipe(result);
  result = dedupeServiceCardVisuals(result);
  result = ensureHomeMenu(result);
  result = ensureGallerySection(result, images, wantsGallery);
  result = ensureGalleryMenu(result, wantsGallery);
  return applyPaletteToHtml(result, palette);
}

function extractUsage(aiResponse) {
  const usage = aiResponse?.usage || {};
  if (usage.input_tokens != null || usage.output_tokens != null) {
    const promptTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    return {
      promptTokens,
      outputTokens,
      totalTokens: promptTokens + outputTokens
    };
  }
  if (usage.prompt_tokens != null || usage.completion_tokens != null) {
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const outputTokens = Number(usage.completion_tokens) || 0;
    return {
      promptTokens,
      outputTokens,
      totalTokens: Number(usage.total_tokens) || promptTokens + outputTokens
    };
  }
  const meta = aiResponse.usageMetadata || {};
  return {
    promptTokens: Number(meta.promptTokenCount) || 0,
    outputTokens: Number(meta.candidatesTokenCount) || 0,
    totalTokens: Number(meta.totalTokenCount) || 0
  };
}

async function generatePlannerResponse(provider, plannerText) {
  if (provider === "claude") {
    return generateClaudeWithRetry([{ type: "text", text: plannerText }], "website prompt");
  }
  return generateContentWithRetry([
    {
      role: "user",
      parts: [createPartFromText(plannerText)]
    }
  ], "website prompt");
}

async function generatePageResponse(provider, pageText, images) {
  if (provider === "claude") {
    const claudeContent = [{ type: "text", text: pageText }];
    for (const image of images) {
      claudeContent.push({ type: "text", text: image.instruction });
      const imageBlock = toClaudeImageBlock(image);
      if (imageBlock) {
        claudeContent.push(imageBlock);
      }
    }
    return generateClaudeWithRetry(claudeContent, "page");
  }
  const pageParts = [createPartFromText(pageText)];
  for (const image of images) {
    pageParts.push(createPartFromText(image.instruction));
    if (image.imagePart) {
      pageParts.push(image.imagePart);
    }
  }
  return generateContentWithRetry([
    {
      role: "user",
      parts: pageParts
    }
  ], "page");
}

function clinicInitials(name) {
  const words = String(name || "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return "CL";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function createNameLogo(clinic, palette = COLOR_PALETTES[0]) {
  const name = String(clinic.clinicName || "Clinic").trim();
  const initials = clinicInitials(name);
  const shortName = name.length > 22 ? `${name.slice(0, 20)}…` : name;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="${escapeHtml(name)} logo"><rect width="256" height="256" rx="56" fill="${palette.deep}"/><text x="128" y="128" text-anchor="middle" dominant-baseline="middle" fill="${palette.onDeep}" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="86" font-weight="800">${escapeHtml(initials)}</text><text x="128" y="198" text-anchor="middle" fill="${palette.onMid}" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="16" font-weight="600">${escapeHtml(shortName)}</text></svg>`;

  return {
    role: "logo",
    fileName: "logo.svg",
    originalName: "generated-logo.svg",
    source: "generated",
    mimeType: "image/svg+xml",
    dataUri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    instruction: `The generated logo is logo.svg. It was created from the clinic name "${name}" using the initials ${initials}. HTML src must be exactly "logo.svg". Use it in the sticky header brand area only. Never stretch it as a hero.`
  };
}

export async function generateClinicPage(clinic, onProgress = () => {}) {
  const palette = pickColorPalette();
  const reference = pickReferenceDesign();
  const referenceNames = (reference.all || []).map((item) => item.id).join(", ") || reference.id;
  console.log(`Using all reference pages (${referenceNames}). Primary layout: ${reference.id}. Palette: ${palette.family}.`);
  onProgress({ percent: 8, step: `Using all reference layouts. Primary: ${reference.id}, colors: ${palette.family}...` });
  const provider = normalizeProvider(clinic.provider);
  const modelName = providerLabel(provider);
  if ((provider === "gemini" || provider === "chatgpt") && !process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. ChatGPT (free) uses the Gemini free models.");
  }
  if (provider === "claude" && !(await getAnthropicApiKey())) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it in Sheet settings or in the .env file.");
  }

  onProgress({ percent: 12, step: "Checking Google Drive for a clinic folder and images..." });
  const { images, warnings, folder } = await loadClinicImages(clinic);
  const wantsGallery = wantsReadyPhotoGallery(clinic.photoGallery);
  if (folder.exists) {
    onProgress({
      percent: 18,
      step: `Found Drive folder "${folder.folderName}"${images.length ? ` with ${images.length} image${images.length === 1 ? "" : "s"}` : ""}.`
    });
  } else {
    onProgress({ percent: 18, step: "No Drive folder found. Using sheet image links if any..." });
  }
  if (needsGeneratedLogo(clinic.logo) && !images.some((image) => image.role === "logo")) {
    onProgress({ percent: 16, step: "No clinic logo or icon file was found. Header will use the clinic name only..." });
  }
  const serviceItems = parseServiceItems(clinic.services);
  const manualReviews = parseManualTestimonials(clinic.manualTestimonials);
  let reviewData = { reviews: [] };
  if (wantsPaidExtraPages(clinic.extraPages)) {
    onProgress({ percent: 22, step: "Fetching Google Maps reviews..." });
    reviewData = await fetchGoogleReviews(clinic);
    if (reviewData.warning && !reviewData.reviews.length && !manualReviews.length) {
      warnings.push(reviewData.warning);
    }
  }

  onProgress({ percent: 35, step: `Studying clinic data with ${modelName} and writing a generation prompt...` });
  let plannerResponse;
  try {
    const plannerText = buildPlannerPrompt(clinic, images, reviewData, palette, reference);
    plannerResponse = await generatePlannerResponse(provider, plannerText);
  } catch (error) {
    throw wrapModelError(provider, error);
  }

  const plannedPrompt = extractText(plannerResponse.text || "");
  if (!plannedPrompt) {
    throw new Error(`${modelName} returned an empty website prompt.`);
  }

  onProgress({ percent: 58, step: `Generating the website with ${modelName}...` });
  let pageResponse;
  try {
    const pageText = buildPagePrompt(plannedPrompt, images, serviceItems, clinic, reviewData, palette, reference);
    pageResponse = await generatePageResponse(provider, pageText, images);
  } catch (error) {
    throw wrapModelError(provider, error);
  }

  const html = extractHtml(pageResponse.text || "");
  if (!html) {
    throw new Error(`${modelName} returned an empty page.`);
  }

  onProgress({ percent: 90, step: "Placing images in the page..." });
  return {
    html: applyPageFixes(embedImagesInHtml(html, images, serviceItems, wantsGallery, palette), clinic, {
      ...reviewData,
      reviews: uniqueTestimonialItems([...manualReviews, ...(reviewData.reviews || [])])
    }, palette, images),
    usage: addUsage(extractUsage(plannerResponse), extractUsage(pageResponse)),
    plannedPrompt,
    warnings
  };
}
