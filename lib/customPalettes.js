import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeHexColor, paletteFromHex } from "./logoPalette.js";

const PALETTE_FILE = path.join(process.cwd(), "custom-palettes.json");
const MAX_CUSTOM = 20;

function slugName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "palette";
}

async function readStore() {
  try {
    const stored = JSON.parse(await readFile(PALETTE_FILE, "utf8"));
    return Array.isArray(stored.palettes) ? stored.palettes : [];
  } catch {
    return [];
  }
}

async function writeStore(palettes) {
  await writeFile(PALETTE_FILE, `${JSON.stringify({ palettes }, null, 2)}\n`, "utf8");
}

export function toPublicPalette(item) {
  return {
    id: item.id,
    family: item.family,
    label: item.label || item.id,
    deep: item.deep,
    mid: item.mid,
    pale: item.pale,
    custom: Boolean(item.custom)
  };
}

export async function listCustomPalettes() {
  return readStore();
}

export async function findCustomPalette(id) {
  const key = String(id || "").trim();
  if (!key.startsWith("custom-")) {
    return null;
  }
  const palettes = await readStore();
  return palettes.find((item) => item.id === key) || null;
}

export async function saveCustomPalette({ name, deep, mid }) {
  const label = String(name || "").trim().slice(0, 32);
  const main = normalizeHexColor(deep);
  if (label.length < 2) {
    throw new Error("Enter a palette name.");
  }
  if (!main) {
    throw new Error("Choose a valid main color.");
  }

  const derived = paletteFromHex(main, { mid: normalizeHexColor(mid) });
  if (!derived) {
    throw new Error("Choose a valid main color.");
  }

  const palettes = await readStore();
  if (palettes.length >= MAX_CUSTOM) {
    throw new Error(`You can save up to ${MAX_CUSTOM} custom palettes.`);
  }

  const palette = {
    ...derived,
    id: `custom-${slugName(label)}-${Date.now().toString(36)}`,
    label,
    custom: true
  };
  palettes.push(palette);
  await writeStore(palettes);
  return palette;
}

export async function deleteCustomPalette(id) {
  const key = String(id || "").trim();
  if (!key.startsWith("custom-")) {
    throw new Error("Built-in palettes cannot be deleted.");
  }
  const palettes = await readStore();
  const next = palettes.filter((item) => item.id !== key);
  if (next.length === palettes.length) {
    throw new Error("Custom palette was not found.");
  }
  await writeStore(next);
  return next;
}
