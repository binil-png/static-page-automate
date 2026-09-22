import { createPartFromBase64, createPartFromText, GoogleGenAI } from "@google/genai";
import { getDriveClient } from "./googleAuth.js";
import { getShareSettings } from "./setupConfig.js";

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
const MAX_ATTEMPTS = 2;
const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
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
  "linkedin.com"
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
  bookingWidget: "Online booking widget code",
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
  return (file.mimeType || "").startsWith("image/")
    || /\.(jpe?g|png|webp|gif)$/i.test(file.name || "");
}

function normalizeMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const ROLE_PLACEMENT = {
  logo: "Use in the sticky header brand area and a small footer or about repeat. Never stretch this as a full-width hero.",
  banner: "Use as the full-width hero/banner directly under the header.",
  about: "Use in the About section next to the clinic description.",
  team: "Use in a team section if extra pages were requested; otherwise in About.",
  service: "Use at the top of the matching service tile. Do not use this as the logo or the main hero.",
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
  const mimeType = contentType.startsWith("image/") ? contentType : "";
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
  const contentType = headerType.startsWith("image/") ? headerType : (mimeHint || headerType || "image/jpeg");
  const bytes = Buffer.from(response.data);
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

  do {
    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, shortcutDetails)",
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

async function addDriveImageSource(drive, fileId, seenIds, imageFiles, depth = 0, source = "filesLink") {
  if (!fileId || seenIds.has(fileId) || depth > 2) {
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
    for (const child of children) {
      await addDriveImageSource(drive, child.id, seenIds, imageFiles, depth + 1, source);
    }
    return;
  }

  if (isImageFile(file)) {
    imageFiles.push({ ...file, source });
  }
}

async function findClinicDriveFolders(drive, parentFolderId, clinic) {
  if (!parentFolderId) {
    return [];
  }

  const result = await drive.files.list({
    q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const needles = [clinic.email, clinic.clinicName]
    .filter(Boolean)
    .map(normalizeMatch)
    .filter((value) => value.length >= 4);

  return (result.data.files || []).filter((folder) => {
    const name = normalizeMatch(folder.name);
    return needles.some((needle) => name.includes(needle));
  });
}

async function collectDriveImageFiles(clinic) {
  const drive = await getDriveClient();
  const seenIds = new Set();
  const imageFiles = [];
  const httpUrls = [];

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
    const settings = await getShareSettings();
    const folders = await findClinicDriveFolders(drive, settings.parentFolderId, clinic);
    for (const folder of folders) {
      await addDriveImageSource(drive, folder.id, seenIds, imageFiles, 0, "driveFolder");
    }
  } catch (error) {
    console.warn(`Drive folder search skipped: ${error.message}`);
  }

  return { imageFiles, httpUrls };
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
  const { imageFiles, httpUrls } = await collectDriveImageFiles(clinic);

  const rankedFiles = [...imageFiles].sort((left, right) => (
    logoPriority(left.name, serviceItems) - logoPriority(right.name, serviceItems)
  ));

  for (const file of rankedFiles.slice(0, 12)) {
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
    if (images.length >= 12) {
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
  if (images.length === 0) {
    warnings.push("No clinic images could be loaded from the sheet or Google Drive.");
  }

  return { images, warnings };
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

function describeResources(images) {
  if (!images.length) {
    return "- No downloadable brand images were provided.";
  }

  return images.map((image) => (
    `- ${image.fileName} | role=${image.role} | original=${image.originalName} | ${ROLE_PLACEMENT[image.role]}`
  )).join("\n");
}

function buildPlannerPrompt(clinic, images) {
  return `You are a senior web-production planner. Study the clinic data from Google Sheets and the listed brand resources. Then write ONE detailed prompt that another model will follow to generate a complete static clinic website.

Clinic data from Google Sheet:
${formatClinicDetails(clinic)}

Available website resources (image files that will be attached in the next step):
${describeResources(images)}

Extra-pages requested: ${wantsFlag(clinic.extraPages) ? "yes" : "no"}
Photo gallery requested: ${wantsFlag(clinic.photoGallery) ? "yes" : "no"}

Your output must be a production-ready prompt that includes:
- The clinic specialty inferred only from the provided about/services text
- Information architecture and sections that the data actually supports
- Exact copy to use from the sheet (name, tagline, phones, email, address, hours, welcome, about, services, social links)
- Visual direction based on the logo/banner when present
- Include a logo in the header only if a resource role is logo. A logo is used when a Drive image filename contains logo or icon (for example logo.png, clinic-logo.jpg, or app-icon.webp). Do not use a service-named icon file as the site logo.
- If a services list exists, build a services section with one tile per service. Every tile must have a visual at the top: use a matching Drive image when the file name relates to that service text; otherwise use a custom inline SVG icon. Do not leave a service tile as text only.
- Where each resource file must be placed, using the exact file names above
- Responsive layout, accessibility, sticky header, click-to-call, and in-page navigation
- Booking widget: embed the provided iframe/code exactly if present
- Map: use the provided Google Maps link only
- Do not invent clinic names, phones, emails, addresses, doctors, testimonials, or extra photos

Return ONLY the detailed website-generation prompt. No HTML. No markdown fences. No commentary.`;
}

function buildPagePrompt(plannedPrompt, images, serviceItems = []) {
  const srcList = images.map((image) => `"${image.fileName}"`).join(", ") || "none";
  const hasLogo = images.some((image) => image.role === "logo");
  const serviceGuide = serviceItems.length
    ? serviceItems.map((service) => {
      const match = images.find((image) => image.matchedService === service);
      return match
        ? `- ${service}: use attached image "${match.fileName}" at the top of this tile`
        : `- ${service}: no matching Drive photo; use a custom inline SVG icon at the top of this tile`;
    }).join("\n")
    : "- No services list was provided. Omit the services section.";

  return `${plannedPrompt}

Hard requirements for this generation:
- Return ONLY a full HTML document. No markdown. No explanation.
- Single file with embedded CSS and a little JS if needed.
- Use the attached brand resources. Reference images with these exact src values: ${srcList}
- Place each attached image in the role described in the brief. Do not leave attached images unused.
- ${hasLogo ? "Use the attached logo file in the header brand area only." : "No Drive image with logo or icon in the file name was provided. Do not add a logo image."}
- If there is a services section, each service tile must include a visual. Prefer a matching attached photo. If there is no matching photo, create a simple custom inline SVG icon for that service. Do not use paid stock. Do not use random unrelated photographs of people.
- Services and visuals:
${serviceGuide}
- Do not invent clinic details.
- Do not use placeholder, stock, or generated fake photos except the custom SVG service icons described above.`;
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

async function generateContentWithRetry(contents, label = "page") {
  let lastError;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        console.log(`Generating ${label} with ${model} (attempt ${attempt})...`);
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

function serviceIconGlyph(label) {
  const text = String(label || "").toLowerCase();
  if (/tooth|dental|denture|smile|oral|gum|scaling|whitening|canal|extract/.test(text)) {
    return '<path fill="#1f5c4d" d="M32 12c-7 0-12 6-12 14 0 10 4 22 8 28 2 3 6 3 8 0 4-6 8-18 8-28 0-8-5-14-12-14z"/>';
  }
  if (/implant|crown|bridge/.test(text)) {
    return '<rect x="28" y="12" width="8" height="16" rx="2" fill="#1f5c4d"/><path fill="#1f5c4d" d="M22 30h20l-3 20H25z"/>';
  }
  if (/brace|aligner|ortho/.test(text)) {
    return '<path fill="none" stroke="#1f5c4d" stroke-width="3" d="M18 28c4-8 24-8 28 0"/><path fill="none" stroke="#1f5c4d" stroke-width="3" d="M18 36c4 8 24 8 28 0"/><circle cx="24" cy="32" r="3" fill="#1f5c4d"/><circle cx="32" cy="32" r="3" fill="#1f5c4d"/><circle cx="40" cy="32" r="3" fill="#1f5c4d"/>';
  }
  if (/child|pediatric|kid/.test(text)) {
    return '<circle cx="32" cy="20" r="8" fill="#1f5c4d"/><path fill="#1f5c4d" d="M18 50c2-12 26-12 28 0v2H18z"/>';
  }
  if (/skin|derma|acne|hair|cosmo/.test(text)) {
    return '<circle cx="32" cy="32" r="14" fill="none" stroke="#1f5c4d" stroke-width="3"/><path fill="#1f5c4d" d="M32 14v6M32 44v6M14 32h6M44 32h6"/>';
  }
  if (/eye|vision|opto|retina/.test(text)) {
    return '<path fill="none" stroke="#1f5c4d" stroke-width="3" d="M12 32c8-12 32-12 40 0-8 12-32 12-40 0z"/><circle cx="32" cy="32" r="6" fill="#1f5c4d"/>';
  }
  if (/physio|rehab|pain|sport|therapy/.test(text)) {
    return '<circle cx="32" cy="14" r="5" fill="#1f5c4d"/><path fill="none" stroke="#1f5c4d" stroke-width="3" d="M32 20v16m0 0l-10 14m10-14l10 14M20 30h24"/>';
  }
  if (/vet|animal|pet|dog|cat/.test(text)) {
    return '<circle cx="20" cy="22" r="6" fill="#1f5c4d"/><circle cx="44" cy="22" r="6" fill="#1f5c4d"/><circle cx="32" cy="36" r="12" fill="#1f5c4d"/>';
  }
  if (/surg|operat/.test(text)) {
    return '<path fill="none" stroke="#1f5c4d" stroke-width="3" d="M20 44l24-24M26 18l4 4M38 42l4 4"/>';
  }
  if (/x[- ]?ray|scan|radio/.test(text)) {
    return '<rect x="16" y="14" width="32" height="36" rx="4" fill="none" stroke="#1f5c4d" stroke-width="3"/><path stroke="#1f5c4d" stroke-width="3" d="M24 24h16M24 32h16M24 40h10"/>';
  }
  if (/heart|cardio/.test(text)) {
    return '<path fill="#1f5c4d" d="M32 50s-16-10-16-22a10 10 0 0 1 16-8 10 10 0 0 1 16 8c0 12-16 22-16 22z"/>';
  }
  if (/vaccine|immun|inject/.test(text)) {
    return '<rect x="36" y="12" width="8" height="14" rx="1" fill="#1f5c4d"/><path fill="#1f5c4d" d="M18 48l16-16 6 6-16 16z"/><path stroke="#1f5c4d" stroke-width="3" d="M40 18l8-8"/>';
  }
  return '<rect x="28" y="14" width="8" height="36" rx="2" fill="#1f5c4d"/><rect x="14" y="28" width="36" height="8" rx="2" fill="#1f5c4d"/>';
}

function serviceIconSvg(label) {
  return `<svg class="service-tile-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="72" height="72" role="img" aria-label="${escapeHtml(label)}"><rect width="64" height="64" rx="16" fill="#1f5c4d" fill-opacity="0.12"/>${serviceIconGlyph(label)}</svg>`;
}

function serviceVisualFor(service, images) {
  const match = images.find((image) => image.matchedService === service)
    || images.find((image) => matchingServiceName(image.originalName, [service]));
  if (match?.dataUri) {
    return `<img class="service-tile-image" src="${match.dataUri}" alt="${escapeHtml(service)}">`;
  }
  return serviceIconSvg(service);
}

function headingAlreadyHasVisual(html, index) {
  const before = html.slice(Math.max(0, index - 360), index).toLowerCase();
  const imgAt = Math.max(before.lastIndexOf("<img"), before.lastIndexOf("<svg"));
  if (imgAt < 0) {
    return false;
  }
  const closer = Math.max(before.lastIndexOf("</article>"), before.lastIndexOf("</div>"), before.lastIndexOf("</li>"));
  return closer < imgAt;
}

function ensureServiceTileVisuals(html, serviceItems, images) {
  if (!serviceItems.length) {
    return html;
  }

  let result = html;
  const style = `.service-tile-icon,.service-tile-image{width:72px;height:72px;object-fit:cover;border-radius:16px;display:block;margin:0 0 12px;}`;
  if (!result.includes("service-tile-icon") && !result.includes("service-tile-image")) {
    result = result.includes("</head>")
      ? result.replace("</head>", `<style>${style}</style></head>`)
      : `<style>${style}</style>${result}`;
  }

  for (const service of serviceItems) {
    const pattern = new RegExp(`<(h[1-6]|p|span|strong|figcaption)([^>]*)>\\s*(${escapeRegExp(service)})\\s*</\\1>`, "i");
    const index = result.search(pattern);
    if (index < 0 || headingAlreadyHasVisual(result, index)) {
      continue;
    }
    result = result.replace(pattern, `${serviceVisualFor(service, images)}<$1$2>$3</$1>`);
  }

  return result;
}

function embedImagesInHtml(html, images, serviceItems = []) {
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

  result = ensureServiceTileVisuals(result, serviceItems, images);

  const unusedGallery = images.filter((image) => !result.includes(image.dataUri));
  if (unusedGallery.length === 0) {
    return result;
  }

  const gallery = unusedGallery.map((image) => (
    `<img src="${image.dataUri}" alt="${image.role} image" style="width:100%;height:auto;border-radius:12px;">`
  )).join("\n");
  const block = `<section id="gallery" style="padding:32px 5%;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));">${gallery}</section>`;

  if (result.includes("</body>")) {
    return result.replace("</body>", `${block}\n</body>`);
  }

  return `${result}\n${block}`;
}

function extractUsage(aiResponse) {
  const usage = aiResponse.usageMetadata || {};
  return {
    promptTokens: Number(usage.promptTokenCount) || 0,
    outputTokens: Number(usage.candidatesTokenCount) || 0,
    totalTokens: Number(usage.totalTokenCount) || 0
  };
}

export async function generateClinicPage(clinic, onProgress = () => {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set.");
  }

  onProgress({ percent: 12, step: "Loading clinic images from Google Drive..." });
  const { images, warnings } = await loadClinicImages(clinic);
  const serviceItems = parseServiceItems(clinic.services);

  onProgress({ percent: 35, step: "Studying clinic data and writing a generation prompt..." });
  let plannerResponse;
  try {
    plannerResponse = await generateContentWithRetry([
      {
        role: "user",
        parts: [createPartFromText(buildPlannerPrompt(clinic, images))]
      }
    ], "website prompt");
  } catch (error) {
    throw wrapGeminiError(error);
  }

  const plannedPrompt = extractText(plannerResponse.text || "");
  if (!plannedPrompt) {
    throw new Error("Gemini returned an empty website prompt.");
  }

  const pageParts = [createPartFromText(buildPagePrompt(plannedPrompt, images, serviceItems))];
  for (const image of images) {
    pageParts.push(createPartFromText(image.instruction));
    pageParts.push(image.imagePart);
  }

  onProgress({ percent: 58, step: "Generating the website from the prompt and images..." });
  let pageResponse;
  try {
    pageResponse = await generateContentWithRetry([
      {
        role: "user",
        parts: pageParts
      }
    ], "page");
  } catch (error) {
    throw wrapGeminiError(error);
  }

  const html = extractHtml(pageResponse.text || "");
  if (!html) {
    throw new Error("Gemini returned an empty page.");
  }

  onProgress({ percent: 90, step: "Placing images in the page..." });
  return {
    html: embedImagesInHtml(html, images, serviceItems),
    usage: addUsage(extractUsage(plannerResponse), extractUsage(pageResponse)),
    plannedPrompt,
    warnings
  };
}
