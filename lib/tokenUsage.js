import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeProvider } from "./setupConfig.js";

const USAGE_FILE = path.join(process.cwd(), "usage.json");

const PROVIDER_RATES = {
  claude: {
    model: "claude-sonnet-4-6",
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15
  },
  chatgpt: {
    model: "gemini-3.8-flash (free)",
    inputPerMillionUsd: 0,
    outputPerMillionUsd: 0
  }
};

function emptyBucket() {
  return {
    last: null,
    totals: {
      promptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: 0,
      generations: 0
    }
  };
}

function emptyStore() {
  return {
    claude: emptyBucket(),
    gemini: emptyBucket(),
    chatgpt: emptyBucket()
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function estimateProviderUsd(provider, promptTokens, outputTokens) {
  const rates = PROVIDER_RATES[provider];
  if (!rates) {
    return 0;
  }
  return (toNumber(promptTokens) / 1_000_000) * rates.inputPerMillionUsd
    + (toNumber(outputTokens) / 1_000_000) * rates.outputPerMillionUsd;
}

function normalizeUsage(usage = {}) {
  const promptTokens = toNumber(usage.promptTokens);
  const outputTokens = toNumber(usage.outputTokens);
  const totalTokens = toNumber(usage.totalTokens) || promptTokens + outputTokens;
  return { promptTokens, outputTokens, totalTokens };
}

export async function loadTokenUsage() {
  try {
    const stored = JSON.parse(await readFile(USAGE_FILE, "utf8"));
    return {
      claude: stored.claude || emptyBucket(),
      gemini: stored.gemini || emptyBucket(),
      chatgpt: stored.chatgpt || emptyBucket()
    };
  } catch {
    return emptyStore();
  }
}

export async function recordTokenUsage(provider, usage, clinic = {}) {
  const key = normalizeProvider(provider);
  const tokens = normalizeUsage(usage);
  const estimatedUsd = estimateProviderUsd(key, tokens.promptTokens, tokens.outputTokens);
  const store = await loadTokenUsage();
  const bucket = store[key] || emptyBucket();
  const last = {
    ...tokens,
    estimatedUsd,
    provider: key,
    clinicId: clinic.id || "",
    clinicName: clinic.clinicName || "",
    at: new Date().toISOString()
  };
  store[key] = {
    last,
    totals: {
      promptTokens: (bucket.totals?.promptTokens || 0) + tokens.promptTokens,
      outputTokens: (bucket.totals?.outputTokens || 0) + tokens.outputTokens,
      totalTokens: (bucket.totals?.totalTokens || 0) + tokens.totalTokens,
      estimatedUsd: Number(((bucket.totals?.estimatedUsd || 0) + estimatedUsd).toFixed(6)),
      generations: (bucket.totals?.generations || 0) + 1
    }
  };
  await writeFile(USAGE_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return getTokenUsageSummary(store, key);
}

function remainingNote(provider) {
  if (provider === "claude") {
    return "Remaining Anthropic credits are not returned by a standard API key. Check console.anthropic.com → Billing.";
  }
  if (provider === "chatgpt") {
    return "ChatGPT generation uses the free Gemini models. No OpenAI billing. Check Google AI Studio quota if a request is refused.";
  }
  return "Gemini remaining balance is not provided by the generate API.";
}

export function getTokenUsageSummary(store, provider = "claude") {
  const key = normalizeProvider(provider);
  const bucket = store[key] || emptyBucket();
  return {
    provider: key,
    last: bucket.last,
    totals: bucket.totals || emptyBucket().totals,
    rates: PROVIDER_RATES[key] || null,
    remainingBalance: null,
    remainingNote: remainingNote(key)
  };
}

export async function getTokenUsage(provider = "claude") {
  const store = await loadTokenUsage();
  return getTokenUsageSummary(store, provider);
}
