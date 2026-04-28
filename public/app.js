const uploadPanels = Array.from(document.querySelectorAll(".upload-panel")).map((panel) => ({
  panel,
  uploadForm: panel.querySelector(".upload-form"),
  fileInput: panel.querySelector(".upload-files"),
  fileNameElement: panel.querySelector(".file-name"),
  submitButton: panel.querySelector(".submit-button"),
  cancelButton: panel.querySelector(".cancel-button"),
  statusElement: panel.querySelector(".upload-status")
}));
const resultsElement = document.querySelector("#results");
const processPanel = document.querySelector(".process-panel");
const processBadge = document.querySelector("#processBadge");
const logoutButton = document.querySelector("#logoutButton");
const loginSuccessScreen = document.querySelector("#loginSuccessScreen");

let activeJobId = null;
let pollTimer = null;
let isPolling = false;
let selectedFile = null;

const processStates = {
  idle: {
    badge: "Waiting",
    badgeClass: "idle"
  },
  processing: {
    badge: "Processing",
    badgeClass: "working"
  },
  success: {
    badge: "Completed",
    badgeClass: "success"
  },
  cancelled: {
    badge: "Cancelled",
    badgeClass: "cancelled"
  },
  error: {
    badge: "Error",
    badgeClass: "error"
  }
};

function setStatus(message, state = "idle") {
  for (const panel of uploadPanels) {
    if (!panel.statusElement) {
      continue;
    }

    panel.statusElement.textContent = message;
    panel.statusElement.className = `status ${state} upload-status`;
  }
}

function setProcessState(state) {
  const nextState = processStates[state] ? state : "idle";
  const content = processStates[nextState];

  if (processPanel) {
    processPanel.dataset.processState = nextState;
  }

  if (processBadge) {
    processBadge.textContent = content.badge;
    processBadge.className = `process-badge ${content.badgeClass}`;
  }
}

function showLoginSuccessAnimation() {
  if (!loginSuccessScreen || sessionStorage.getItem("showLoginSuccess") !== "true") {
    return;
  }

  sessionStorage.removeItem("showLoginSuccess");
  loginSuccessScreen.hidden = false;

  window.setTimeout(() => {
    loginSuccessScreen.classList.add("is-leaving");
  }, 1150);

  window.setTimeout(() => {
    loginSuccessScreen.hidden = true;
    loginSuccessScreen.classList.remove("is-leaving");
  }, 1650);
}

async function handleLogoutClick() {
  try {
    await fetch("/api/logout", {
      method: "POST"
    });
  } finally {
    window.location.href = "/login";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function setSubmitDisabled(disabled) {
  for (const panel of uploadPanels) {
    if (panel.submitButton) {
      panel.submitButton.disabled = disabled;
    }
  }
}

function setFileInputFiles(fileInput, files) {
  if (!fileInput) {
    return;
  }

  if (!files.length) {
    fileInput.value = "";
    return;
  }

  if (typeof DataTransfer !== "function") {
    return;
  }

  try {
    const dataTransfer = new DataTransfer();

    for (const file of files) {
      dataTransfer.items.add(file);
    }

    fileInput.files = dataTransfer.files;
  } catch {
    // Some browsers do not allow programmatic FileList assignment.
  }
}

function updateFileNameDisplay() {
  const fileName = selectedFile?.name ?? "No file selected";

  for (const panel of uploadPanels) {
    if (panel.fileNameElement) {
      panel.fileNameElement.textContent = fileName;
    }
  }
}

function syncFileInputs(sourceInput) {
  const files = Array.from(sourceInput?.files || []);
  selectedFile = files[0] ?? null;

  for (const panel of uploadPanels) {
    if (panel.fileInput === sourceInput) {
      continue;
    }

    setFileInputFiles(panel.fileInput, files);
  }

  updateFileNameDisplay();
}

function getSelectedFile() {
  if (selectedFile) {
    return selectedFile;
  }

  for (const panel of uploadPanels) {
    if (panel.fileInput?.files?.length) {
      return panel.fileInput.files[0];
    }
  }

  return null;
}

async function readApiPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();

  if (contentType.includes("application/json")) {
    try {
      return rawText ? JSON.parse(rawText) : {};
    } catch {
      if (!response.ok) {
        throw new Error(`Server returned invalid JSON (${response.status}).`);
      }

      throw new Error("Server returned an invalid JSON response.");
    }
  }

  if (!response.ok) {
    const normalized = rawText.trim();

    if (response.status === 404 && normalized.startsWith("Not Found")) {
      throw new Error(
        "The API endpoint was not found. On Render, this app must be deployed as a Web Service, not as a Static Site."
      );
    }

    throw new Error(normalized || `The request failed (${response.status}).`);
  }

  if (!rawText.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error("Server returned a non-JSON response.");
  }
}

function isFinalJobStatus(status) {
  return (
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function formatElapsed(seconds) {
  if (!seconds) {
    return null;
  }

  if (seconds < 60) {
    return `${seconds}s elapsed`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s elapsed`;
}

function describeResult(result) {
  if (result.status === "queued") {
    return "The file is waiting for processing to start.";
  }

  if (result.status === "cancelling") {
    return "Cancelling the request.";
  }

  if (result.status === "processing") {
    const parts = [];

    if (result.stage === "uploading_to_openai") {
      parts.push("The file is being uploaded for processing.");
    } else if (result.stage === "uploaded_to_openai") {
      parts.push("The file has been uploaded and is ready for analysis.");
    } else if (result.stage === "response_created") {
      parts.push("Analysis has started.");
    } else if (result.stage === "waiting_for_openai") {
      parts.push("Labels are being extracted and the final file is being prepared.");
    } else if (result.stage === "finalizing_output") {
      parts.push("Finalizing the result for download.");
    } else {
      parts.push("The file is being processed.");
    }

    const elapsed = formatElapsed(result.elapsedSeconds);
    if (elapsed) {
      parts.push(elapsed);
    }

    return parts.join(" ");
  }

  if (result.status === "cancelled") {
    return "The analysis was cancelled before the file was generated.";
  }

  if (result.status === "failed") {
    return result.error || "File processing failed.";
  }

  if (result.generatedFile) {
    return "The Excel file is ready for download.";
  }

  return "Processing finished, but the Excel file is not available.";
}

function renderEmptyState() {
  resultsElement.innerHTML = `
    <div class="empty-state">
      <strong>No processed files yet.</strong>
      <span>Upload a \`.xlsx\` file to start generating labels.</span>
    </div>
  `;
}

function renderResults(results) {
  if (!results.length) {
    renderEmptyState();
    return;
  }

  resultsElement.innerHTML = results
    .map((result) => {
      const badgeClass =
        result.status === "failed"
          ? "error"
          : result.status === "completed"
            ? "success"
            : result.status === "cancelled"
              ? "cancelled"
              : "working";

      const badgeLabel =
        result.status === "queued"
          ? "Waiting"
          : result.status === "processing"
            ? "Processing"
            : result.status === "cancelling"
              ? "Cancelling"
              : result.status === "completed"
                ? "Completed"
                : result.status === "cancelled"
                  ? "Cancelled"
                  : "Error";

      const actions =
        result.status === "completed" && result.generatedFile
          ? `<a class="download-link" href="${escapeHtml(result.generatedFile.url)}" download="${escapeHtml(
              result.generatedFile.filename
            )}">Download generated file</a>`
          : result.status === "completed"
            ? '<span class="download-link disabled">Excel file unavailable</span>'
            : "";

      const copyClass =
        result.status === "completed"
          ? result.generatedFile
            ? "success-copy"
            : "pending-copy"
          : result.status === "failed"
            ? "error-copy"
            : "pending-copy";

      return `
        <article class="result-card ${result.status === "failed" ? "error" : ""}">
          <div class="result-header">
            <div>
              <span class="result-label">Processed file</span>
              <h3>${escapeHtml(result.inputFilename)}</h3>
            </div>
            <span class="badge ${badgeClass}">${badgeLabel}</span>
          </div>
          <p class="${copyClass}">${escapeHtml(describeResult(result))}</p>
          ${actions ? `<div class="actions">${actions}</div>` : ""}
        </article>
      `;
    })
    .join("");
}

function updateCancelButton(job = null) {
  const canShow =
    job &&
    activeJobId === job.id &&
    (job.status === "queued" || job.status === "processing" || job.status === "cancelling");

  for (const panel of uploadPanels) {
    if (!panel.cancelButton) {
      continue;
    }

    panel.cancelButton.hidden = !canShow;
    panel.cancelButton.textContent = job?.status === "cancelling" ? "Cancelling..." : "Cancel analysis";
    panel.cancelButton.disabled = !canShow || job?.status === "cancelling";
  }
}

function updateStatusFromJob(job) {
  const primaryResult = Array.isArray(job.results) ? job.results[0] : null;

  if (job.status === "queued") {
    setStatus("The job is waiting. The file is ready.", "working");
    setProcessState("processing");
    updateCancelButton(job);
    return;
  }

  if (job.status === "processing") {
    setStatus("The file is being processed.", "working");
    setProcessState("processing");
    updateCancelButton(job);
    return;
  }

  if (job.status === "cancelling") {
    setStatus("Cancelling the request.", "working");
    setProcessState("processing");
    updateCancelButton(job);
    return;
  }

  if (job.status === "completed") {
    if (primaryResult?.generatedFile) {
      setStatus("Processing completed. The file is ready.", "success");
      setProcessState("success");
    } else {
      setStatus("Processing finished, but the file is not available.", "error");
      setProcessState("error");
    }
    updateCancelButton(null);
    return;
  }

  if (job.status === "completed_with_errors") {
    setStatus("Processing finished with errors.", "error");
    setProcessState("error");
    updateCancelButton(null);
    return;
  }

  if (job.status === "cancelled") {
    setStatus("Analysis was cancelled.", "idle");
    setProcessState("cancelled");
    updateCancelButton(null);
    return;
  }

  setStatus("The job could not be completed.", "error");
  setProcessState("error");
  updateCancelButton(null);
}

async function pollJob(jobId) {
  if (isPolling || activeJobId !== jobId) {
    return;
  }

  isPolling = true;

  try {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await readApiPayload(response);

    if (!response.ok) {
      throw new Error(job.error || "Could not read the processing status.");
    }

    renderResults(job.results || []);
    updateStatusFromJob(job);

    if (isFinalJobStatus(job.status)) {
      setSubmitDisabled(false);
      activeJobId = null;
      updateCancelButton(null);
      stopPolling();
      return;
    }

    pollTimer = setTimeout(() => {
      void pollJob(jobId);
    }, 3000);
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "A problem occurred while updating the status.",
      "error"
    );
    setProcessState("error");
    setSubmitDisabled(false);
    updateCancelButton(null);
    activeJobId = null;
    stopPolling();
  } finally {
    isPolling = false;
  }
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await readApiPayload(response);

    if (!data.openaiConfigured) {
      setStatus("The app is not fully configured for processing.", "error");
      setProcessState("error");
    }
  } catch {
    setStatus("Could not verify app availability.", "error");
    setProcessState("error");
  }
}

async function handleUploadSubmit(event) {
  event.preventDefault();

  const file = getSelectedFile();

  if (!file) {
    setStatus("Select a `.xlsx` file.", "error");
    setProcessState("idle");
    return;
  }

  stopPolling();
  activeJobId = null;
  updateCancelButton(null);

  const formData = new FormData();
  formData.append("files", file);

  setSubmitDisabled(true);
  setStatus("The file is being sent for processing...", "working");
  setProcessState("processing");

  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      body: formData
    });
    const payload = await readApiPayload(response);

    if (!response.ok) {
      throw new Error(payload.error || "The request could not be processed.");
    }

    activeJobId = payload.id;
    renderResults(payload.results || []);
    updateStatusFromJob(payload);
    void pollJob(payload.id);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "The request failed.", "error");
    setProcessState("error");
    setSubmitDisabled(false);
    updateCancelButton(null);
  }
}

async function handleCancelClick() {
  if (!activeJobId) {
    return;
  }

  for (const panel of uploadPanels) {
    if (!panel.cancelButton) {
      continue;
    }

    panel.cancelButton.disabled = true;
    panel.cancelButton.textContent = "Cancelling...";
  }

  setStatus("Cancelling the request...", "working");

  try {
    const response = await fetch(`/api/jobs/${activeJobId}/cancel`, {
      method: "POST"
    });
    const payload = await readApiPayload(response);

    if (!response.ok) {
      throw new Error(payload.error || "Could not cancel the analysis.");
    }

    renderResults(payload.results || []);
    updateStatusFromJob(payload);

    if (isFinalJobStatus(payload.status)) {
      setSubmitDisabled(false);
      activeJobId = null;
      updateCancelButton(null);
      stopPolling();
      return;
    }

    void pollJob(payload.id);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not cancel the analysis.", "error");
    updateCancelButton(activeJobId ? { id: activeJobId, status: "processing" } : null);
  }
}

function handleFileChange(fileInput) {
  syncFileInputs(fileInput);

  if (getSelectedFile()) {
    setProcessState("idle");
    setStatus("The file is ready for processing.", "idle");
  } else {
    selectedFile = null;
    updateFileNameDisplay();
    setProcessState("idle");
    setStatus("Select a `.xlsx` file.", "idle");
  }
}

for (const panel of uploadPanels) {
  panel.uploadForm?.addEventListener("submit", handleUploadSubmit);
  panel.cancelButton?.addEventListener("click", handleCancelClick);
  panel.fileInput?.addEventListener("change", () => {
    handleFileChange(panel.fileInput);
  });
}

logoutButton?.addEventListener("click", handleLogoutClick);

updateFileNameDisplay();
updateCancelButton(null);
setProcessState("idle");
showLoginSuccessAnimation();
void loadHealth();
