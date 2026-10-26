import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseEnvValue(raw) {
  let value = String(raw || "").trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!key || (process.env[key] != null && process.env[key] !== "")) {
      continue;
    }
    process.env[key] = parseEnvValue(trimmed.slice(eq + 1));
  }
}

loadEnvFile(path.join(process.cwd(), ".env"));
