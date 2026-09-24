const clinicSelect = document.getElementById("clinicSelect");
const refreshBtn = document.getElementById("refreshBtn");
const generateBtn = document.getElementById("generateBtn");
const testimonialsBox = document.getElementById("testimonialsBox");
const modelGemini = document.getElementById("modelGemini");
const modelClaude = document.getElementById("modelClaude");
const modelChatGpt = document.getElementById("modelChatGpt");
const claudeSteps = document.getElementById("claudeSteps");
const tokenDetailsTitle = document.getElementById("tokenDetailsTitle");
const tokenLast = document.getElementById("tokenLast");
const tokenCost = document.getElementById("tokenCost");
const tokenTotals = document.getElementById("tokenTotals");
const tokenRemaining = document.getElementById("tokenRemaining");
const tokenRates = document.getElementById("tokenRates");
const anthropicApiKey = document.getElementById("anthropicApiKey");
const anthropicKeyStatus = document.getElementById("anthropicKeyStatus");
const openaiApiKey = document.getElementById("openaiApiKey");
const openaiKeyStatus = document.getElementById("openaiKeyStatus");
const downloadBtn = document.getElementById("downloadBtn");
const generateProgress = document.getElementById("generateProgress");
const generateProgressBar = document.getElementById("generateProgressBar");
const generateProgressLabel = document.getElementById("generateProgressLabel");
const generateProgressPct = document.getElementById("generateProgressPct");
const generateProgressTrack = generateProgress.querySelector(".progress-track");
const clinicDetails = document.getElementById("clinicDetails");
const statusEl = document.getElementById("status");
const tokenUsageEl = document.getElementById("tokenUsage");
const plannedPromptBox = document.getElementById("plannedPromptBox");
const plannedPromptText = document.getElementById("plannedPromptText");
const appError = document.getElementById("appError");
const appErrorText = document.getElementById("appErrorText");
const appErrorClose = document.getElementById("appErrorClose");
const setupStatusEl = document.getElementById("setupStatus");
const preview = document.getElementById("preview");
const emptyPreview = document.getElementById("emptyPreview");
const connectionBadge = document.getElementById("connectionBadge");
const credentialsFile = document.getElementById("credentialsFile");
const credentialsStatus = document.getElementById("credentialsStatus");
const emailBox = document.getElementById("emailBox");
const serviceAccountEmail = document.getElementById("serviceAccountEmail");
const sheetUrl = document.getElementById("sheetUrl");
const sheetTab = document.getElementById("sheetTab");
const sheetGid = document.getElementById("sheetGid");
const saveSetupBtn = document.getElementById("saveSetupBtn");
const copyEmailBtn = document.getElementById("copyEmailBtn");
const settingsToggle = document.getElementById("settingsToggle");
const setupPanel = document.getElementById("setupPanel");
const formUrl = document.getElementById("formUrl");
const parentFolderId = document.getElementById("parentFolderId");
const clientEmail = document.getElementById("clientEmail");
const shareFormBtn = document.getElementById("shareFormBtn");
const shareStatusEl = document.getElementById("shareStatus");
const shareResult = document.getElementById("shareResult");
const sharedFormLink = document.getElementById("sharedFormLink");
const sharedFolderLink = document.getElementById("sharedFolderLink");
const folderStatus = document.getElementById("folderStatus");
const openFolderBtn = document.getElementById("openFolderBtn");
const createFolderBtn = document.getElementById("createFolderBtn");
const stepItems = document.querySelectorAll(".steps li");

let generated = null;
let folderRequestId = 0;
let progressTimer = null;
let displayedPercent = 0;
let testimonialsClinicId = "";

function showAppError(message) {
  appErrorText.textContent = message;
  appError.hidden = false;
}

function clearAppError() {
  appError.hidden = true;
  appErrorText.textContent = "";
}

function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
  if (isError && message) {
    showAppError(message);
  }
}

function setStatus(message, isError = false) {
  setMessage(statusEl, message, isError);
}

function formatUsd(value) {
  const amount = Number(value) || 0;
  return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;
}

function formatTokenCount(value) {
  return Number(value || 0).toLocaleString();
}

function setTokenUsage(usage) {
  if (!usage || !usage.totalTokens) {
    tokenUsageEl.hidden = true;
    tokenUsageEl.textContent = "";
    return;
  }

  tokenUsageEl.hidden = false;
  const cost = usage.estimatedUsd != null ? ` Estimated cost ${formatUsd(usage.estimatedUsd)}.` : "";
  tokenUsageEl.textContent = `Tokens this generation: ${formatTokenCount(usage.totalTokens)} total (${formatTokenCount(usage.promptTokens)} input, ${formatTokenCount(usage.outputTokens)} output).${cost} Remaining wallet is not provided by the API key.`;
}

function providerTitle(provider) {
  if (provider === "claude") {
    return "Claude";
  }
  if (provider === "chatgpt") {
    return "ChatGPT";
  }
  return "Gemini";
}

function renderTokenDetails(details) {
  const name = providerTitle(details?.provider || selectedProvider());
  tokenDetailsTitle.textContent = `${name} token details`;
  if (!details) {
    tokenLast.textContent = `No ${name} generation yet.`;
    tokenCost.textContent = "$0.00";
    tokenTotals.textContent = "0 tokens";
    return;
  }

  if (details.rates) {
    tokenRates.textContent = `${details.rates.model}: $${details.rates.inputPerMillionUsd} / 1M input tokens, $${details.rates.outputPerMillionUsd} / 1M output tokens.`;
  }
  if (details.last?.totalTokens) {
    const when = details.last.at ? ` (${new Date(details.last.at).toLocaleString()})` : "";
    const clinic = details.last.clinicName ? ` for ${details.last.clinicName}` : "";
    tokenLast.textContent = `${formatTokenCount(details.last.totalTokens)} total (${formatTokenCount(details.last.promptTokens)} input, ${formatTokenCount(details.last.outputTokens)} output)${clinic}${when}.`;
    tokenCost.textContent = formatUsd(details.last.estimatedUsd);
  } else {
    tokenLast.textContent = `No ${name} generation yet.`;
    tokenCost.textContent = "$0.00";
  }
  const totals = details.totals || {};
  tokenTotals.textContent = totals.generations
    ? `${formatTokenCount(totals.totalTokens)} tokens in ${totals.generations} generation${totals.generations === 1 ? "" : "s"} (${formatUsd(totals.estimatedUsd)} estimated).`
    : "0 tokens";
  tokenRemaining.textContent = details.remainingNote
    || "Not available from this API key.";
}

async function loadTokenDetails() {
  const details = await fetchJson(`/api/usage?provider=${encodeURIComponent(selectedProvider())}`);
  renderTokenDetails(details);
  return details;
}

function setPlannedPrompt(prompt) {
  if (!prompt) {
    plannedPromptBox.hidden = true;
    plannedPromptText.textContent = "";
    return;
  }

  plannedPromptBox.hidden = false;
  plannedPromptText.textContent = prompt;
}

function setSetupStatus(message, isError = false) {
  setMessage(setupStatusEl, message, isError);
}

function setShareStatus(message, isError = false) {
  setMessage(shareStatusEl, message, isError);
}

function textOrDash(value) {
  return value && String(value).trim() ? value : "Not provided";
}

function setCurrentStep(index) {
  stepItems.forEach((item, stepIndex) => {
    item.classList.toggle("is-current", stepIndex === index);
  });
}

async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const message = String(error?.message || "");
    if (error.name === "TypeError" || /failed to fetch/i.test(message)) {
      throw new Error("Failed to fetch: the browser lost the connection. Keep npm start running, wait for generation to finish (this can take several minutes), then try again.");
    }
    throw new Error("Cannot reach the server. Start the app with npm start and try again.");
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(response.ok
      ? "The server returned an invalid response."
      : `Server error (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(data.error || data.message || `Request failed (${response.status}).`);
  }

  return data;
}

function renderConnection(setup) {
  if (setup.ready) {
    connectionBadge.textContent = "Sheet connected";
    connectionBadge.className = "badge is-ready";
  } else {
    connectionBadge.textContent = "Sheet not connected";
    connectionBadge.className = "badge is-error";
  }

  if (setup.hasCredentials && setup.serviceAccountEmail) {
    credentialsStatus.textContent = "Service account key is saved.";
    serviceAccountEmail.textContent = setup.serviceAccountEmail;
    emailBox.hidden = false;
  } else {
    credentialsStatus.textContent = "No key uploaded yet.";
    emailBox.hidden = true;
  }

  sheetUrl.value = setup.sheetUrl || setup.sheetId || "";
  sheetTab.value = setup.tab || "";
  sheetGid.value = setup.gid || "";
  formUrl.value = setup.formUrl || "";
  parentFolderId.value = setup.parentFolderId || "";
  anthropicApiKey.value = "";
  anthropicApiKey.placeholder = setup.hasClaudeKey ? "Claude key is saved. Paste a new key to replace it." : "sk-ant-...";
  anthropicKeyStatus.textContent = setup.hasClaudeKey
    ? "Claude API key is saved."
    : "No Claude key saved yet. Add it here or in the .env file.";
  openaiApiKey.value = "";
  openaiApiKey.placeholder = setup.hasChatGptKey ? "ChatGPT key is saved. Paste a new key to replace it." : "sk-...";
  openaiKeyStatus.textContent = setup.hasChatGptKey
    ? "ChatGPT API key is saved."
    : "No ChatGPT key saved yet. Add it here or in the .env file.";
}

function renderClinicOptions(clinics, selectedId) {
  clinicSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = clinics.length ? "Select a clinic" : "No clinics found";
  clinicSelect.append(placeholder);

  for (const clinic of clinics) {
    const option = document.createElement("option");
    option.value = clinic.id;
    option.textContent = clinic.clinicName;
    clinicSelect.append(option);
  }

  clinicSelect.value = selectedId && clinics.some((clinic) => clinic.id === selectedId) ? selectedId : "";
}

function resetFolderUi(message) {
  folderStatus.textContent = message;
  folderStatus.classList.remove("error");
  openFolderBtn.hidden = true;
  openFolderBtn.removeAttribute("href");
  createFolderBtn.hidden = true;
  createFolderBtn.disabled = true;
  createFolderBtn.textContent = "Create Drive folder";
}

function renderFolder(result) {
  createFolderBtn.hidden = false;
  createFolderBtn.disabled = false;
  createFolderBtn.textContent = result.exists ? "Create new Drive folder" : "Create Drive folder";

  if (!result.exists || !result.folderLink) {
    folderStatus.textContent = "No Drive folder found for this clinic.";
    openFolderBtn.hidden = true;
    openFolderBtn.removeAttribute("href");
    return;
  }

  folderStatus.textContent = result.created
    ? `Created Drive folder: ${result.folderName}`
    : `Drive folder found: ${result.folderName}`;
  openFolderBtn.hidden = false;
  openFolderBtn.href = result.folderLink;
}

async function loadClinicFolder(clinicId) {
  const requestId = ++folderRequestId;
  resetFolderUi("Checking Drive folder...");
  createFolderBtn.hidden = false;

  try {
    const result = await fetchJson(`/api/clinics/${encodeURIComponent(clinicId)}/folder`);
    if (requestId !== folderRequestId) {
      return;
    }
    renderFolder(result);
  } catch (error) {
    if (requestId !== folderRequestId) {
      return;
    }
    folderStatus.textContent = error.message;
    folderStatus.classList.add("error");
    createFolderBtn.hidden = false;
    createFolderBtn.disabled = false;
  }
}

async function createSelectedClinicFolder() {
  if (!clinicSelect.value) {
    return;
  }

  const requestId = folderRequestId;
  createFolderBtn.disabled = true;
  folderStatus.classList.remove("error");
  folderStatus.textContent = "Creating Drive folder...";

  try {
    const result = await fetchJson(`/api/clinics/${encodeURIComponent(clinicSelect.value)}/folder`, {
      method: "POST"
    });
    if (requestId !== folderRequestId) {
      return;
    }
    renderFolder(result);
  } catch (error) {
    if (requestId !== folderRequestId) {
      return;
    }
    folderStatus.textContent = error.message;
    folderStatus.classList.add("error");
    createFolderBtn.disabled = false;
  }
}

function renderClinicDetails(clinic) {
  if (!clinic) {
    clinicDetails.hidden = true;
    generateBtn.disabled = true;
    resetFolderUi("Select a clinic to check its Drive folder.");
    return;
  }

  document.getElementById("detailName").textContent = clinic.clinicName;
  document.getElementById("detailTagline").textContent = clinic.tagline || "";
  document.getElementById("detailAddress").textContent = textOrDash(clinic.address);
  document.getElementById("detailPhone").textContent = textOrDash(clinic.contactNumbers || clinic.supportNumber);
  document.getElementById("detailEmail").textContent = textOrDash(clinic.email);
  document.getElementById("detailTiming").textContent = textOrDash(clinic.timing);
  clinicDetails.hidden = false;
  generateBtn.disabled = false;
}

async function loadSelectedClinic() {
  generated = null;
  downloadBtn.hidden = true;
  preview.hidden = true;
  emptyPreview.hidden = false;
  hideGenerateProgress();

  if (!clinicSelect.value) {
    renderClinicDetails(null);
    testimonialsBox.value = "";
    testimonialsClinicId = "";
    setCurrentStep(1);
    return;
  }

  if (clinicSelect.value !== testimonialsClinicId) {
    testimonialsBox.value = "";
    testimonialsClinicId = clinicSelect.value;
  }

  const clinic = await fetchJson(`/api/clinics/${encodeURIComponent(clinicSelect.value)}`);
  renderClinicDetails(clinic);
  setCurrentStep(2);
  await loadClinicFolder(clinic.id);
}

async function loadClinics(forceRefresh = false) {
  const selectedId = clinicSelect.value;
  clinicSelect.innerHTML = "<option>Loading clinics...</option>";
  generateBtn.disabled = true;

  const clinics = await fetchJson(forceRefresh ? "/api/clinics?refresh=1" : "/api/clinics");
  renderClinicOptions(clinics, selectedId);
  await loadSelectedClinic();
  setSetupStatus(clinics.length ? `${clinics.length} clinics loaded.` : "No clinics found in the sheet.");
  setCurrentStep(clinicSelect.value ? 2 : 1);
}

function showPreview(previewUrl, downloadUrl) {
  preview.src = previewUrl;
  preview.hidden = false;
  emptyPreview.hidden = true;
  downloadBtn.hidden = false;
  downloadBtn.href = downloadUrl;
  downloadBtn.download = "index.html";
  setCurrentStep(3);
}

async function uploadCredentials(file) {
  let key;
  try {
    key = JSON.parse(await file.text());
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  const result = await fetchJson("/api/setup/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credentials: key })
  });
  serviceAccountEmail.textContent = result.serviceAccountEmail;
  emailBox.hidden = false;
  credentialsStatus.textContent = "Service account key is saved.";
  setSetupStatus("Key saved. Share the sheet with the email shown, then save the sheet URL.");
}

async function saveSetupAndLoad() {
  saveSetupBtn.disabled = true;
  setSetupStatus("Saving sheet connection...");

  try {
    await fetchJson("/api/setup/sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sheetUrl: sheetUrl.value,
        tab: sheetTab.value,
        gid: sheetGid.value,
        formUrl: formUrl.value,
        parentFolderId: parentFolderId.value,
        anthropicApiKey: anthropicApiKey.value,
        openaiApiKey: openaiApiKey.value
      })
    });
    await loadSetup();
    await loadClinics(true);
  } catch (error) {
    clinicSelect.innerHTML = "<option value=\"\">Could not load clinics</option>";
    setSetupStatus(error.message, true);
    setCurrentStep(0);
  } finally {
    saveSetupBtn.disabled = false;
  }
}

function setGenerateProgressUi(percent, step) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  displayedPercent = value;
  generateProgress.hidden = false;
  generateProgressBar.style.width = `${value}%`;
  generateProgressPct.textContent = `${value}%`;
  generateProgressTrack.setAttribute("aria-valuenow", String(value));
  if (step) {
    generateProgressLabel.textContent = step;
  }
}

function hideGenerateProgress() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  generateProgress.hidden = true;
  generateProgressBar.style.width = "0%";
  generateProgressPct.textContent = "0%";
  generateProgressLabel.textContent = "Starting...";
  generateProgressTrack.setAttribute("aria-valuenow", "0");
  displayedPercent = 0;
}

async function pollGenerateProgress() {
  try {
    const progress = await fetchJson("/api/generate/progress");
    const serverPercent = Number(progress.percent) || 0;
    const next = Math.max(displayedPercent, serverPercent);
    setGenerateProgressUi(next, progress.step || generateProgressLabel.textContent);
  } catch {
    if (displayedPercent < 92) {
      setGenerateProgressUi(displayedPercent + 1, generateProgressLabel.textContent);
    }
  }
}

function startGenerateProgress() {
  if (progressTimer) {
    clearInterval(progressTimer);
  }
  setGenerateProgressUi(4, "Starting website generation...");
  progressTimer = setInterval(() => {
    pollGenerateProgress();
    if (displayedPercent > 0 && displayedPercent < 92) {
      setGenerateProgressUi(Math.min(92, displayedPercent + 0.4), generateProgressLabel.textContent);
    }
  }, 800);
}

async function generateWebsite() {
  if (!clinicSelect.value) {
    setStatus("Select a clinic first.", true);
    return;
  }

  generateBtn.disabled = true;
  startGenerateProgress();
  setStatus("Generating website. This can take several minutes...");
  setTokenUsage(null);
  setPlannedPrompt("");
  setCurrentStep(2);

  try {
    const result = await fetchJson("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clinicId: clinicSelect.value,
        testimonials: testimonialsBox.value,
        provider: selectedProvider()
      })
    });
    generated = result;
    setGenerateProgressUi(100, "Website ready.");
    showPreview(result.previewUrl, result.downloadUrl);
    setStatus(`${result.clinicName} website is ready.`);
    setTokenUsage(result.tokenDetails?.last || result.usage);
    if (result.tokenDetails) {
      renderTokenDetails(result.tokenDetails);
    }
    setPlannedPrompt(result.plannedPrompt);
    if (result.warnings?.length) {
      showAppError(result.warnings.join(" "));
    } else {
      clearAppError();
    }
  } catch (error) {
    hideGenerateProgress();
    setStatus(error.message, true);
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    generateBtn.disabled = !clinicSelect.value;
  }
}

async function loadSetup() {
  const setup = await fetchJson("/api/setup");
  renderConnection(setup);
  return setup;
}

credentialsFile.addEventListener("change", () => {
  const file = credentialsFile.files[0];
  if (!file) {
    return;
  }

  uploadCredentials(file).catch((error) => setSetupStatus(error.message, true));
});

saveSetupBtn.addEventListener("click", () => {
  saveSetupAndLoad().catch((error) => setSetupStatus(error.message, true));
});

settingsToggle.addEventListener("click", () => {
  setupPanel.hidden = !setupPanel.hidden;
  settingsToggle.textContent = setupPanel.hidden ? "Sheet settings" : "Hide sheet settings";
});

async function shareForm() {
  shareFormBtn.disabled = true;
  shareResult.hidden = true;
  setShareStatus("Creating the Drive folder and sending the form...");
  setCurrentStep(0);

  try {
    const result = await fetchJson("/api/share-form", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: clientEmail.value })
    });
    sharedFormLink.href = result.formLink;
    sharedFolderLink.href = result.folderLink;
    shareResult.hidden = false;
    setShareStatus(result.emailSent
      ? `Form and folder sent to ${result.email}.`
      : `Folder shared with ${result.email}. ${result.emailNote}`);
  } catch (error) {
    setShareStatus(error.message, true);
  } finally {
    shareFormBtn.disabled = false;
  }
}

shareFormBtn.addEventListener("click", () => {
  shareForm().catch((error) => setShareStatus(error.message, true));
});

copyEmailBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(serviceAccountEmail.textContent);
    setSetupStatus("Service account email copied.");
  } catch {
    setSetupStatus("Could not copy the email. Copy it manually.", true);
  }
});

appErrorClose.addEventListener("click", () => {
  clearAppError();
});

window.addEventListener("error", (event) => {
  const message = event.message || "";
  if (/failed to fetch|script error/i.test(message)) {
    return;
  }
  showAppError(message || "An unexpected browser error occurred.");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const message = reason?.message || String(reason || "An unexpected error occurred.");
  if (/failed to fetch/i.test(message)) {
    return;
  }
  showAppError(message);
});

clinicSelect.addEventListener("change", () => {
  setStatus("");
  loadSelectedClinic().catch((error) => setStatus(error.message, true));
});

refreshBtn.addEventListener("click", () => {
  setSetupStatus("Refreshing clinic list...");
  loadClinics(true).catch((error) => setSetupStatus(error.message, true));
});

function selectedProvider() {
  if (modelClaude.checked) {
    return "claude";
  }
  if (modelChatGpt.checked) {
    return "chatgpt";
  }
  return "gemini";
}

function syncModelUi() {
  const provider = selectedProvider();
  const showTokens = provider === "claude" || provider === "chatgpt";
  claudeSteps.hidden = !showTokens;
  if (showTokens) {
    loadTokenDetails().catch(() => {});
  }
}

modelGemini.addEventListener("change", syncModelUi);
modelClaude.addEventListener("change", syncModelUi);
modelChatGpt.addEventListener("change", syncModelUi);
syncModelUi();

generateBtn.addEventListener("click", () => {
  generateWebsite().catch((error) => setStatus(error.message, true));
});

createFolderBtn.addEventListener("click", () => {
  createSelectedClinicFolder().catch((error) => {
    folderStatus.textContent = error.message;
    folderStatus.classList.add("error");
    createFolderBtn.disabled = false;
  });
});

loadSetup()
  .then((setup) => {
    if (setup.ready) {
      return loadClinics();
    }
    clinicSelect.innerHTML = "<option value=\"\">Connect the sheet first</option>";
    setCurrentStep(0);
    return null;
  })
  .catch((error) => {
    connectionBadge.textContent = "Sheet not connected";
    connectionBadge.className = "badge is-error";
    clinicSelect.innerHTML = "<option value=\"\">Could not load clinics</option>";
    setupPanel.hidden = false;
    settingsToggle.textContent = "Hide sheet settings";
    setSetupStatus(error.message, true);
  });
