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
  service: "Use next to a matching service item when possible.",
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

function fileLooksLikeLogo(name) {
  const text = String(name || "").toLowerCase();
  return text.includes("logo") || text.includes("icon");
}

function inferImageRole(name, source, size, taken) {
  if (fileLooksLikeLogo(name)) {
    return taken.has("logo") ? "gallery" : "logo";
  }
  const label = `${name || ""} ${source || ""}`.toLowerCase();
  if (/banner|hero|cover|wide/.test(label)) {
    return taken.has("banner") ? "gallery" : "banner";
  }
  if (/about|building|exterior|interior|facility|reception/.test(label)) {
    return "about";
  }
  if (/team|staff|doctor|dentist/.test(label)) {
    return "team";
  }
  if (/service|treatment|procedure/.test(label)) {
    return "service";
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

function forceLogo(images) {
  if (!images.length || images.some((image) => image.role === "logo")) {
    return images;
  }

  const index = images.findIndex((image) => fileLooksLikeLogo(image.originalName));
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

function logoPriority(name) {
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

function assignImageMeta(image, originalName, source, taken, counts) {
  const size = readImageSize(Buffer.from(image.dataUri.split(",")[1], "base64"), image.mimeType);
  const role = inferImageRole(originalName, source, size, taken);
  taken.add(role);
  const ext = extensionForImage(image.mimeType, originalName);
  const fileName = roleFileName(role, counts, ext);
  return {
    ...image,
    role,
    originalName: originalName || fileName,
    source: source || "",
    fileName,
    instruction: `The next attached image is the ${role}. HTML src must be exactly "${fileName}". Original file name: ${originalName || "unknown"}. ${ROLE_PLACEMENT[role]}`
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
  const { imageFiles, httpUrls } = await collectDriveImageFiles(clinic);

  const rankedFiles = [...imageFiles].sort((left, right) => (
    logoPriority(left.name) - logoPriority(right.name)
  ));

  for (const file of rankedFiles.slice(0, 12)) {
    try {
      const downloaded = await downloadDriveImage(file.id, file.name || file.id, images.length, file.mimeType);
      images.push(assignImageMeta(downloaded, file.name || file.id, file.source, taken, counts));
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
      images.push(assignImageMeta(downloaded, candidate.url, candidate.source, taken, counts));
    } catch (error) {
      const message = `Could not use image ${candidate.url}: ${error.message}`;
      warnings.push(message);
      console.warn(message);
    }
  }

  forceLogo(images);
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
- Include a logo in the header only if a resource role is logo. A logo is used when a Drive image filename contains logo or icon (for example logo.png, clinic-logo.jpg, or app-icon.webp).
- Where each resource file must be placed, using the exact file names above
- Responsive layout, accessibility, sticky header, click-to-call, and in-page navigation
- Booking widget: embed the provided iframe/code exactly if present
- Map: use the provided Google Maps link only
- Do not invent clinic names, phones, emails, addresses, doctors, testimonials, or extra photos

Return ONLY the detailed website-generation prompt. No HTML. No markdown fences. No commentary.`;
}

function buildPagePrompt(plannedPrompt, images) {
  const srcList = images.map((image) => `"${image.fileName}"`).join(", ") || "none";
  const hasLogo = images.some((image) => image.role === "logo");

  return `${plannedPrompt}

Hard requirements for this generation:
- Return ONLY a full HTML document. No markdown. No explanation.
- Single file with embedded CSS and a little JS if needed.
- Use the attached brand resources. Reference images with these exact src values: ${srcList}
- Place each attached image in the role described in the brief. Do not leave attached images unused.
- ${hasLogo ? "Use the attached logo file in the header brand area only." : "No Drive image with logo or icon in the file name was provided. Do not add a logo image."}
- Do not invent clinic details or extra photos.
- Do not use placeholder, stock, or generated fake photos.`;
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

function embedImagesInHtml(html, images) {
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

  const pageParts = [createPartFromText(buildPagePrompt(plannedPrompt, images))];
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
    html: embedImagesInHtml(html, images),
    usage: addUsage(extractUsage(plannerResponse), extractUsage(pageResponse)),
    plannedPrompt,
    warnings
  };
}
