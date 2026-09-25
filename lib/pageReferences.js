import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REFERENCE_DIR = path.join(process.cwd(), "public", "references");
const STATE_FILE = path.join(process.cwd(), "last-reference.json");

const DESIGN_NOTES = {
  "classic.html": `Classic bright clinic. Plus Jakarta Sans headings, Nunito body. Soft mint wash, never a dark bar or dark hero. Sticky white header, Home-first nav, rounded Contact chip. Light hero with pale gradient and dark readable type. About split with a pale accent card. Soft 3-column service cards. Light footer.`,
  "editorial.html": `Warm editorial clinic. Playfair Display headings, Nunito body. Cream page, centered wordmark, underline nav. Large serif hero on a pale wash. Numbered service list. Masonry gallery. One paper contact card. No black sections.`,
  "minimal.html": `Airy clinic. DM Sans headings, Nunito body. White space, hairline borders, small uppercase labels. Slim header. Simple two-column services. Square gallery. Narrow light contact column.`,
  "bold.html": `Confident but light clinic. Poppins headings, Source Sans 3 body. Large type on cream, not a dark viewport. Soft full-width service rows. Wide light gallery strip. Contact is a pale info panel plus a white form. No black backgrounds.`,
  "page-reference .html": `Original clinic structure. Keep the section order and cards, but restyle it as a bright clinic page: pale hero, white header, light footer. Do not copy clinic names or dark slate-900 surfaces.`
};

function listReferenceFiles() {
  try {
    return readdirSync(REFERENCE_DIR)
      .filter((name) => name.toLowerCase().endsWith(".html") && name.toLowerCase() !== "index.html")
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function lightenReferenceExcerpt(html) {
  return String(html || "")
    .replace(/\bbg-black\b/gi, "bg-teal-50")
    .replace(/\b(?:bg|from|via|to)-(?:slate|neutral|zinc|stone|gray|black|teal)-(?:800|900|950)\b/gi, (token) => {
      if (/^via-/i.test(token)) {
        return "via-white";
      }
      if (/^to-/i.test(token)) {
        return "to-teal-100";
      }
      return token.replace(/-(?:slate|neutral|zinc|stone|gray|black|teal)-(?:800|900|950)$/i, "-teal-50");
    })
    .replace(/\btext-white\b/gi, "text-slate-800");
}

function sanitizeReferenceHtml(html) {
  return lightenReferenceExcerpt(String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/src=["']data:[^"']+["']/gi, "src=\"\"")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim());
}

function briefFor(fileName) {
  return DESIGN_NOTES[fileName] || `Follow the HTML structure in public/references/${fileName}. Copy layout only. Do not copy sample clinic text.`;
}

function readReference(fileName) {
  let html = "";
  try {
    html = readFileSync(path.join(REFERENCE_DIR, fileName), "utf8");
  } catch {
    html = "";
  }
  return {
    id: fileName.replace(/\.html$/i, "").replace(/\s+/g, "-").replace(/-+/g, "-"),
    fileName,
    html,
    brief: briefFor(fileName)
  };
}

export function loadAllReferenceDesigns() {
  return listReferenceFiles().map(readReference).filter((item) => item.html);
}

function loadLastReferenceId() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")).id || "";
  } catch {
    return "";
  }
}

function persistLastReference(id) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ id }));
  } catch {
    // keep in-memory rotation if the file cannot be saved
  }
}

let lastReferenceId = loadLastReferenceId();

export function pickReferenceDesign() {
  const all = loadAllReferenceDesigns();
  if (!all.length) {
    return {
      id: "classic",
      fileName: "",
      html: "",
      brief: DESIGN_NOTES["classic.html"],
      all: []
    };
  }

  const lastIndex = all.findIndex((item) => item.fileName === lastReferenceId);
  const next = all[(lastIndex + 1) % all.length];
  lastReferenceId = next.fileName;
  persistLastReference(next.fileName);
  return { ...next, all };
}

export function referenceCatalog(reference) {
  const all = reference.all?.length ? reference.all : loadAllReferenceDesigns();
  if (!all.length) {
    return "No HTML files were found in public/references.";
  }

  return all.map((item, index) => (
    `${index + 1}. ${item.id} (${item.fileName}): ${item.brief}`
  )).join("\n");
}

export function referenceStyleGuide(reference, palette) {
  const family = palette.family;
  const catalog = referenceCatalog(reference);
  return `Use every HTML file in public/references as the layout library:
${catalog}

This generation's PRIMARY layout is ${reference.id} (public/references/${reference.fileName}).
Follow that file's structure, spacing, typography, and components.
You may borrow a section pattern from the other reference files in the same folder when it fits, but keep ONE coherent design. Do not mash every layout into one page.

Copy layout only. Do not copy any clinic name, address, phone, email, doctor, city, years, services, testimonials, or body copy from any reference file. Use only the live clinic sheet data.

Stack:
- Tailwind CSS v4 from https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4
- Lucide icons from https://unpkg.com/lucide@latest and call lucide.createIcons() at the end
- Clinic fonts only: Playfair Display or Plus Jakarta Sans for headings; Nunito, Poppins, DM Sans, or Source Sans 3 for body. Load them from Google Fonts.

This generation MUST stay light and clinic-like. No black, slate-900, or dark full-width bands. Recolor accents to ${family}.
Accent hex values: deep ${palette.deep}, mid ${palette.mid}, bright ${palette.bright}, pale ${palette.pale}.
Use pale surfaces (bg-${family}-50, bg-white, cream). Buttons may use bg-${family}-500. Never use bg-${family}-900 or from-${family}-900.

Shared rules for every reference:
- Desktop and mobile nav start with Home (#home). Hero/top section id="home".
- Exactly one contact section id="contact" and exactly one Send a message form.
- Phone CTA buttons say Contact, not the number.
- Service cards are title and description only. No icon on top of a service card.
- Header logo/icon only when a real clinic logo or icon file exists. Otherwise clinic name only; no invented brand icon.
- Testimonials only when testimonial copy exists; exactly one #testimonials swipe row; each unique review once; show the reviewer name on the card when a name is provided.
- Social row includes a WhatsApp icon linked to https://wa.me/ plus the clinic phone digits.
- Do not invent highlight stats, years, or extra photos.`;
}

export function referenceLayoutExcerpt(reference) {
  const all = reference.all?.length ? reference.all : [reference];
  return all.map((item) => {
    const excerpt = sanitizeReferenceHtml(item.html).slice(0, 3500);
    const label = item.fileName === reference.fileName ? "PRIMARY" : "also in folder";
    return `--- ${item.fileName} (${label}) ---\n${excerpt || "File could not be read."}`;
  }).join("\n\n");
}
