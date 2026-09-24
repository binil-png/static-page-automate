import { createPartFromBase64, createPartFromText, GoogleGenAI } from "@google/genai";
import { getDriveClient } from "./googleAuth.js";
import { fetchGoogleReviews, formatReviewsForPrompt } from "./googleReviews.js";
import { getAnthropicApiKey, getShareSettings } from "./setupConfig.js";

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
const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
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

    items.push({
      author: "",
      text: chunk,
      rating: 0,
      relativeTime: ""
    });
  }

  return items.slice(0, 12);
}

function formatManualTestimonialsForPrompt(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "No manual testimonials were entered.";
  }
  return text;
}

const PAGE_STYLE_GUIDE = `Visual style only. Copy this look. Do not copy any clinic name, address, phone, email, doctor, city, years, services, or body copy from any reference page.

Stack:
- Tailwind CSS v4 from https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4
- Lucide icons from https://unpkg.com/lucide@latest and call lucide.createIcons() at the end
- Google font Plus Jakarta Sans (weights 300-800)

Colors and surfaces:
- Page: bg-slate-50 text-slate-800
- Top utility bar: bg-teal-900 text-teal-100, small type, map-pin / phone / mail icons in teal-400
- Sticky header: white/95 backdrop-blur, h-20, bottom border slate-100
- Nav links: slate-700, hover teal-600, font-semibold
- Hero: full-width gradient from-teal-900 via-teal-800 to-slate-900, white type, dotted radial overlay, teal/blue blurred orbs
- Hero heading accent: gradient text from-teal-300 via-teal-200 to-white
- Primary CTA: bg-teal-500 hover:bg-teal-400 text-slate-950 rounded-xl bold shadow
- Secondary CTA: white/10 border white/20 rounded-xl
- About: white section, 12-column grid, left teal-900 card with teal-400 eyebrow, right slate headings
- Section eyebrows: small uppercase teal pills (bg-teal-50 or bg-teal-100)
- Services: bg-slate-100, white rounded-2xl cards, border-slate-200, teal-50 icon tile that flips to teal-600 on hover
- Gallery: white or slate-50, rounded-2xl image cards
- Contact: labeled columns for address, phone, email, timing; teal icon chips
- Footer: dark teal/slate with small social icon buttons
- Testimonials: white cards, rounded-2xl, teal stars, slate text

Layout:
- max-w-7xl mx-auto px-4 sm:px-6 lg:px-8
- sticky header with logo (if provided) plus clinic name, desktop nav, optional phone chip, mobile hamburger
- sections only when this clinic's data supports them: home/hero, about, services, gallery, testimonials, contact, footer
- Book an appointment uses the provided booking URL, not a dummy #contact link, when a booking URL exists
- Do not invent highlight stats, years, or feature cards unless that fact is in the clinic sheet data`;

function describeResources(images) {
  if (!images.length) {
    return "- No downloadable brand images were provided.";
  }

  return images.map((image) => (
    `- ${image.fileName} | role=${image.role} | original=${image.originalName} | ${ROLE_PLACEMENT[image.role]}`
  )).join("\n");
}

function buildPlannerPrompt(clinic, images, reviewData = { reviews: [] }) {
  return `You are a senior web-production planner. Study the clinic data from Google Sheets and the listed brand resources. Then write ONE detailed prompt that another model will follow to generate a complete static clinic website.

Clinic data from Google Sheet:
${formatClinicDetails(clinic)}

Available website resources (image files that will be attached in the next step):
${describeResources(images)}

Google Maps reviews fetched from the clinic location link:
${formatReviewsForPrompt(reviewData)}

Manual testimonials entered in the generator:
${formatManualTestimonialsForPrompt(clinic.manualTestimonials)}

Extra-pages requested: ${wantsFlag(clinic.extraPages) ? "yes" : "no"}
Photo gallery requested: ${wantsFlag(clinic.photoGallery) ? "yes" : "no"}

Visual style to follow (layout, colors, type, components only):
${PAGE_STYLE_GUIDE}

Your output must be a production-ready prompt that includes:
- The clinic specialty inferred only from the provided about/services text
- Information architecture and sections that the data actually supports
- Exact copy to use from the sheet (name, tagline, phones, email, address, hours, welcome, about, services, social links)
- Match the visual style guide above. Do not reuse any sample clinic content. Infer accent tweaks from the logo/banner only if they stay in the teal/slate family.
- Include a logo in the header only if a logo resource is present (a Drive file named logo/icon, or a generated name logo when Create logo was checked). Do not invent a logo otherwise.
- If a services list exists, build a services section with one tile per service. Every tile must have a visual at the top: use a matching Drive image when the file name relates to that service text; otherwise use a custom inline SVG icon. Do not leave a service tile as text only.
- Social media: every social link must use a recognizable brand icon (Facebook, Instagram, YouTube, X/Twitter, LinkedIn, WhatsApp, TikTok). Do not show social URLs as plain text only.
- Contact area: include labeled columns for address, phone, email, and timing when those values exist. Email must appear in the contact section as a mailto link.
- Booking: if an online booking URL is provided, add a "Book an appointment" button/link that navigates to that URL on click. Use only the URL. Do not embed an iframe or widget code.
- Testimonials: add a testimonials section using the manual testimonials entered in the generator and any Google Maps reviews that were fetched. Use that copy only. Do not invent reviews.
- Where each resource file must be placed, using the exact file names above
- Responsive layout, accessibility, sticky header, click-to-call, and in-page navigation
- Map: use the provided Google Maps link only
- Do not invent clinic names, phones, emails, addresses, doctors, testimonials, or extra photos

Return ONLY the detailed website-generation prompt. No HTML. No markdown fences. No commentary.`;
}

function buildPagePrompt(plannedPrompt, images, serviceItems = [], clinic = {}, reviewData = { reviews: [] }) {
  const srcList = images.map((image) => `"${image.fileName}"`).join(", ") || "none";
  const hasLogo = images.some((image) => image.role === "logo");
  const generatedLogo = images.some((image) => image.role === "logo" && image.source === "generated");
  const logoRule = generatedLogo
    ? "Use the generated logo.svg in the sticky header brand area. It was created from the clinic name. Do not invent a different logo."
    : hasLogo
      ? "Use the attached logo file in the header brand area only."
      : "No logo was provided and Create logo was not checked. Do not add a logo image.";
  const bookingUrl = extractBookingUrl(clinic.bookingWidget);
  const serviceGuide = serviceItems.length
    ? serviceItems.map((service) => {
      const match = images.find((image) => image.matchedService === service);
      return match
        ? `- ${service}: use attached image "${match.fileName}" at the top of this tile`
        : `- ${service}: no matching Drive photo; use a custom inline SVG icon at the top of this tile`;
    }).join("\n")
    : "- No services list was provided. Omit the services section.";
  const manualText = formatManualTestimonialsForPrompt(clinic.manualTestimonials);
  const hasManual = manualText !== "No manual testimonials were entered.";
  const reviewGuide = reviewData.reviews?.length || hasManual
    ? `Add a testimonials section using this copy only. Do not invent extra reviews.\nManual testimonials:\n${manualText}\n\nGoogle Maps reviews:\n${formatReviewsForPrompt(reviewData)}`
    : "No testimonials were entered and no Google Maps reviews were fetched. Do not invent a testimonials section.";

  return `${plannedPrompt}

Hard requirements for this generation:
- Return ONLY a full HTML document. No markdown. No explanation.
- Follow the visual style guide in the brief: Tailwind CDN, Lucide icons, Plus Jakarta Sans, teal/slate clinic layout (top bar, sticky header, gradient hero, about split, service cards, contact columns).
- Do not copy names, phones, emails, addresses, services, testimonials, or any other content from a sample/reference clinic. Use only the clinic data in this prompt.
- Include Tailwind and Lucide script tags. Call lucide.createIcons() after the markup. Extra embedded CSS is allowed for logo/gallery/testimonial tweaks.
- Use the attached brand resources. Reference images with these exact src values: ${srcList}
- Place each attached image in the role described in the brief. Do not leave attached images unused.
- ${logoRule}
- If there is a services section, each service tile must include a visual. Prefer a matching attached photo. If there is no matching photo, create a simple custom inline SVG icon for that service. Do not use paid stock. Do not use random unrelated photographs of people.
- Services and visuals:
${serviceGuide}
- Give every social media link a brand icon. Keep the links working.
- In the contact section, show Email as its own labeled column when an email is provided${clinic.email ? `: ${clinic.email}` : ""}.
- ${bookingUrl ? `Add a "Book an appointment" button whose href is exactly ${bookingUrl}. On click, navigate to that URL (target _blank). Do not embed a booking iframe or paste widget HTML.` : "No booking URL was provided. Omit the Book an appointment button."}
- ${reviewGuide}
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

function wrapModelError(provider, error) {
  return provider === "claude" ? wrapClaudeError(error) : wrapGeminiError(error);
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
  return `<svg class="service-tile-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56" role="img" aria-label="${escapeHtml(label)}"><rect width="64" height="64" rx="16" fill="#0f766e" fill-opacity="0.12"/>${serviceIconGlyph(label)}</svg>`;
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
  const style = `.service-tile-icon,.service-tile-image{width:56px;height:56px;object-fit:cover;border-radius:16px;display:block;margin:0 0 20px;background:#f0fdfa;}`;
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

function pageFixStyles() {
  return `<style id="clinic-page-fixes">
.social-links{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.social-link{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:999px;background:#0f766e;color:#fff;text-decoration:none}
.social-link span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.booking-btn{display:inline-flex;align-items:center;justify-content:center;padding:14px 22px;border-radius:12px;background:#14b8a6;color:#042f2e;text-decoration:none;font-weight:700}
.contact-email,.contact-item{margin:8px 0}
.contact-label{display:block;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;font-weight:700}
#testimonials{padding:80px 5%;background:#f8fafc}
.testimonials-head{display:flex;justify-content:space-between;gap:16px;align-items:end;flex-wrap:wrap;margin-bottom:32px;max-width:80rem;margin-left:auto;margin-right:auto}
.testimonials-grid{display:grid;gap:24px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));max-width:80rem;margin:0 auto}
.testimonial-card{padding:28px;border:1px solid #e2e8f0;border-radius:16px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.testimonial-stars{margin:0 0 8px;color:#0d9488;letter-spacing:2px}
.testimonial-card blockquote{margin:0 0 12px;color:#334155}
.testimonial-author{margin:0;font-weight:700;color:#0f172a}
.testimonial-time{margin:4px 0 0;color:#64748b;font-size:.9rem}
.service-tile-icon,.service-tile-image{width:56px;height:56px;object-fit:cover;border-radius:16px;display:block;margin:0 0 20px;background:#f0fdfa}
</style>`;
}

function ensurePageFixStyles(html) {
  if (html.includes("id=\"clinic-page-fixes\"")) {
    return html;
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", `${pageFixStyles()}</head>`);
  }
  return `${pageFixStyles()}${html}`;
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

function ensureEmailInContact(html, email) {
  if (!email) {
    return html;
  }

  const hasLabeledEmail = /<(dt|th|span|p|label|strong)[^>]*>\s*email\s*</i.test(html)
    && html.toLowerCase().includes(email.toLowerCase());
  if (hasLabeledEmail) {
    return html;
  }

  const row = `<div class="contact-item contact-email"><span class="contact-label">Email</span><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></div>`;
  const contactOpen = html.match(/<(section|div|address|ul|dl)[^>]*id=["']contact["'][^>]*>/i)
    || html.match(/<(section|div)[^>]*class=["'][^"']*contact[^"']*["'][^>]*>/i);

  if (contactOpen) {
    return html.replace(contactOpen[0], `${contactOpen[0]}\n${row}`);
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

function testimonialsSectionHtml(reviewData) {
  const cards = reviewData.reviews.map((review) => (
    `<article class="testimonial-card">${review.rating ? `<p class="testimonial-stars" aria-label="${review.rating} out of 5">${starRating(review.rating)}</p>` : ""}<blockquote>${escapeHtml(review.text)}</blockquote>${review.author ? `<p class="testimonial-author">${escapeHtml(review.author)}</p>` : ""}${review.relativeTime ? `<p class="testimonial-time">${escapeHtml(review.relativeTime)}</p>` : ""}</article>`
  )).join("");
  const ratingLine = reviewData.rating
    ? `<p class="muted">${escapeHtml(String(reviewData.rating))}/5${reviewData.total ? ` from ${reviewData.total} Google reviews` : ""}</p>`
    : "";
  const moreLink = reviewData.mapsUrl
    ? `<a href="${escapeHtml(reviewData.mapsUrl)}" target="_blank" rel="noopener noreferrer">See reviews on Google</a>`
    : "";

  return `<section id="testimonials"><div class="testimonials-head"><div><h2>Testimonials</h2>${ratingLine}</div>${moreLink}</div><div class="testimonials-grid">${cards}</div></section>`;
}

function ensureTestimonials(html, reviewData) {
  if (!reviewData?.reviews?.length) {
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

function applyPageFixes(html, clinic, reviewData = { reviews: [] }) {
  const bookingUrl = extractBookingUrl(clinic.bookingWidget);
  let result = ensurePageFixStyles(html);
  result = ensureSocialIcons(result, clinic.socialLinks);
  result = ensureBookingButton(result, bookingUrl);
  result = ensureEmailInContact(result, clinic.email);
  result = ensureTestimonials(result, reviewData);
  return result;
}

function extractUsage(aiResponse) {
  if (aiResponse?.usage?.input_tokens != null || aiResponse?.usage?.output_tokens != null) {
    const promptTokens = Number(aiResponse.usage.input_tokens) || 0;
    const outputTokens = Number(aiResponse.usage.output_tokens) || 0;
    return {
      promptTokens,
      outputTokens,
      totalTokens: promptTokens + outputTokens
    };
  }
  const usage = aiResponse.usageMetadata || {};
  return {
    promptTokens: Number(usage.promptTokenCount) || 0,
    outputTokens: Number(usage.candidatesTokenCount) || 0,
    totalTokens: Number(usage.totalTokenCount) || 0
  };
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

function createNameLogo(clinic) {
  const name = String(clinic.clinicName || "Clinic").trim();
  const initials = clinicInitials(name);
  const shortName = name.length > 22 ? `${name.slice(0, 20)}…` : name;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="${escapeHtml(name)} logo"><rect width="256" height="256" rx="56" fill="#0f766e"/><text x="128" y="128" text-anchor="middle" dominant-baseline="middle" fill="#ecfdf5" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="86" font-weight="800">${escapeHtml(initials)}</text><text x="128" y="198" text-anchor="middle" fill="#99f6e4" font-family="Plus Jakarta Sans, Segoe UI, sans-serif" font-size="16" font-weight="600">${escapeHtml(shortName)}</text></svg>`;

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
  const provider = clinic.provider === "claude" ? "claude" : "gemini";
  const modelName = provider === "claude" ? "Claude" : "Gemini";
  if (provider === "gemini" && !process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set.");
  }
  if (provider === "claude" && !(await getAnthropicApiKey())) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it in Sheet settings or in the .env file.");
  }

  onProgress({ percent: 12, step: "Loading clinic images from Google Drive..." });
  const { images, warnings } = await loadClinicImages(clinic);
  if (clinic.createLogo && !images.some((image) => image.role === "logo")) {
    onProgress({ percent: 16, step: "Creating a logo from the clinic name..." });
    images.push(createNameLogo(clinic));
  }
  const serviceItems = parseServiceItems(clinic.services);

  onProgress({ percent: 22, step: "Fetching Google Maps reviews..." });
  const reviewData = await fetchGoogleReviews(clinic);
  const manualReviews = parseManualTestimonials(clinic.manualTestimonials);
  if (reviewData.warning && !reviewData.reviews.length && !manualReviews.length) {
    warnings.push(reviewData.warning);
  }

  onProgress({ percent: 35, step: `Studying clinic data with ${modelName} and writing a generation prompt...` });
  let plannerResponse;
  try {
    const plannerText = buildPlannerPrompt(clinic, images, reviewData);
    plannerResponse = provider === "claude"
      ? await generateClaudeWithRetry([{ type: "text", text: plannerText }], "website prompt")
      : await generateContentWithRetry([
        {
          role: "user",
          parts: [createPartFromText(plannerText)]
        }
      ], "website prompt");
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
    const pageText = buildPagePrompt(plannedPrompt, images, serviceItems, clinic, reviewData);
    if (provider === "claude") {
      const claudeContent = [{ type: "text", text: pageText }];
      for (const image of images) {
        claudeContent.push({ type: "text", text: image.instruction });
        const imageBlock = toClaudeImageBlock(image);
        if (imageBlock) {
          claudeContent.push(imageBlock);
        }
      }
      pageResponse = await generateClaudeWithRetry(claudeContent, "page");
    } else {
      const pageParts = [createPartFromText(pageText)];
      for (const image of images) {
        pageParts.push(createPartFromText(image.instruction));
        if (image.imagePart) {
          pageParts.push(image.imagePart);
        }
      }
      pageResponse = await generateContentWithRetry([
        {
          role: "user",
          parts: pageParts
        }
      ], "page");
    }
  } catch (error) {
    throw wrapModelError(provider, error);
  }

  const html = extractHtml(pageResponse.text || "");
  if (!html) {
    throw new Error(`${modelName} returned an empty page.`);
  }

  onProgress({ percent: 90, step: "Placing images in the page..." });
  return {
    html: applyPageFixes(embedImagesInHtml(html, images, serviceItems), clinic, {
      ...reviewData,
      reviews: [...manualReviews, ...(reviewData.reviews || [])]
    }),
    usage: addUsage(extractUsage(plannerResponse), extractUsage(pageResponse)),
    plannedPrompt,
    warnings
  };
}
