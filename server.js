import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearClinicCache, getClinicById, listClinics, toClinicSummary } from "./lib/clinics.js";
import { createClinicFolder, findClinicFolder } from "./lib/clinicFolder.js";
import { generateClinicPage } from "./lib/generate.js";
import { getServiceAccountFilePath, getServiceAccountInfo, resetGoogleAuth } from "./lib/googleAuth.js";
import { shareFormWithClient } from "./lib/shareForm.js";
import { getShareSettings, getSheetSettings, saveSetupConfig } from "./lib/setupConfig.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const generatedPages = new Map();
const GENERATED_DIR = path.join(process.cwd(), "generated");
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
let generateInProgress = false;
let generateProgress = {
  active: false,
  percent: 0,
  step: "",
  clinicId: "",
  clinicName: ""
};

function setGenerateProgress(update) {
  generateProgress = { ...generateProgress, ...update };
}

function toPublicError(error) {
  const googleMessage = error.errors?.[0]?.message
    || error.response?.data?.error?.message
    || error.cause?.message;
  const rawStatus = Number(error.code || error.status || error.response?.status);
  const status = rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  return {
    status,
    message: googleMessage || error.message || "Server error."
  };
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/setup", async (_req, res, next) => {
  try {
    const credentials = await getServiceAccountInfo();
    const sheet = await getSheetSettings();
    const share = await getShareSettings();
    res.json({
      hasCredentials: credentials.hasCredentials,
      serviceAccountEmail: credentials.email,
      hasSheet: Boolean(sheet.sheetId),
      sheetUrl: sheet.sheetUrl || "",
      sheetId: sheet.sheetId || "",
      tab: sheet.tab || "",
      gid: sheet.gid || "",
      formUrl: share.formUrl || "",
      parentFolderId: share.parentFolderId || "",
      ready: credentials.hasCredentials && Boolean(sheet.sheetId)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup/credentials", async (req, res, next) => {
  try {
    const key = req.body?.credentials && typeof req.body.credentials === "object" ? req.body.credentials : req.body;
    if (!key?.client_email || !key?.private_key) {
      res.status(400).json({ error: "Upload a valid service account JSON key." });
      return;
    }

    await writeFile(getServiceAccountFilePath(), `${JSON.stringify(key, null, 2)}\n`, "utf8");
    resetGoogleAuth();
    clearClinicCache();
    res.json({ hasCredentials: true, serviceAccountEmail: key.client_email });
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup/sheet", async (req, res, next) => {
  try {
    const config = await saveSetupConfig({
      sheetUrl: req.body?.sheetUrl || req.body?.sheetId,
      sheetId: req.body?.sheetId,
      tab: req.body?.tab,
      gid: req.body?.gid,
      formUrl: req.body?.formUrl,
      parentFolderId: req.body?.parentFolderId
    });
    clearClinicCache();
    res.json(config);
  } catch (error) {
    next(error);
  }
});

app.post("/api/share-form", async (req, res, next) => {
  try {
    const result = await shareFormWithClient(req.body?.email);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/clinics", async (req, res, next) => {
  try {
    const clinics = await listClinics(req.query.refresh === "1");
    res.json(clinics.map(toClinicSummary));
  } catch (error) {
    next(error);
  }
});

app.get("/api/clinics/:id", async (req, res, next) => {
  try {
    const clinic = await getClinicById(req.params.id);
    if (!clinic) {
      res.status(404).json({ error: "Clinic not found." });
      return;
    }
    res.json(clinic);
  } catch (error) {
    next(error);
  }
});

app.get("/api/clinics/:id/folder", async (req, res, next) => {
  try {
    const clinic = await getClinicById(req.params.id);
    if (!clinic) {
      res.status(404).json({ error: "Clinic not found." });
      return;
    }
    res.json(await findClinicFolder(clinic));
  } catch (error) {
    next(error);
  }
});

app.post("/api/clinics/:id/folder", async (req, res, next) => {
  try {
    const clinic = await getClinicById(req.params.id);
    if (!clinic) {
      res.status(404).json({ error: "Clinic not found." });
      return;
    }
    res.json(await createClinicFolder(clinic));
  } catch (error) {
    next(error);
  }
});

app.post("/api/generate", async (req, res, next) => {
  if (generateInProgress) {
    res.status(409).json({ error: "A website is already being generated. Wait for it to finish, then try again." });
    return;
  }

  generateInProgress = true;
  setGenerateProgress({
    active: true,
    percent: 5,
    step: "Starting website generation...",
    clinicId: req.body?.clinicId || "",
    clinicName: ""
  });
  try {
    const clinic = await getClinicById(req.body?.clinicId);
    if (!clinic) {
      res.status(404).json({ error: "Select a clinic from the list." });
      return;
    }

    setGenerateProgress({
      clinicId: clinic.id,
      clinicName: clinic.clinicName,
      percent: 8,
      step: "Loading clinic details..."
    });
    const generated = await generateClinicPage(clinic, (progress) => {
      setGenerateProgress(progress);
    });
    setGenerateProgress({ percent: 96, step: "Saving the website..." });
    const fileName = `${clinic.id}-index.html`;
    await mkdir(GENERATED_DIR, { recursive: true });
    const outputPath = path.join(GENERATED_DIR, fileName);
    await writeFile(outputPath, generated.html, "utf8");
    generatedPages.set(clinic.id, { fileName, clinicName: clinic.clinicName, outputPath });
    setGenerateProgress({ percent: 100, step: "Website ready." });
    res.json({
      clinicId: clinic.id,
      clinicName: clinic.clinicName,
      fileName,
      previewUrl: `/preview/${encodeURIComponent(clinic.id)}`,
      downloadUrl: `/api/download/${encodeURIComponent(clinic.id)}`,
      usage: generated.usage,
      plannedPrompt: generated.plannedPrompt || "",
      warnings: generated.warnings || []
    });
  } catch (error) {
    next(error);
  } finally {
    generateInProgress = false;
    setGenerateProgress({
      active: false,
      percent: generateProgress.percent === 100 ? 100 : 0,
      step: generateProgress.percent === 100 ? "Website ready." : ""
    });
  }
});

app.get("/api/generate/progress", (_req, res) => {
  res.json(generateProgress);
});

app.get("/preview/:id", (req, res) => {
  const page = generatedPages.get(req.params.id);
  if (!page?.outputPath) {
    res.status(404).send("Generate the website before previewing.");
    return;
  }

  res.sendFile(page.outputPath);
});

app.get("/api/download/:id", (req, res) => {
  const page = generatedPages.get(req.params.id);
  if (!page?.outputPath) {
    res.status(404).json({ error: "Generate the website before downloading." });
    return;
  }

  res.download(page.outputPath, "index.html");
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const publicError = toPublicError(error);
  res.status(publicError.status).json({ error: publicError.message });
});

const server = app.listen(PORT, () => {
  console.log(`Clinic website generator running at http://localhost:${PORT}`);
});

server.timeout = REQUEST_TIMEOUT_MS;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = REQUEST_TIMEOUT_MS + 10000;
server.keepAliveTimeout = REQUEST_TIMEOUT_MS + 5000;

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT to a free port.`);
    process.exit(1);
  }
  console.error(error);
});
