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

let activeJobId = null;
let pollTimer = null;
let isPolling = false;
let selectedFile = null;

const processStates = {
  idle: {
    badge: "În așteptare",
    badgeClass: "idle"
  },
  processing: {
    badge: "În procesare",
    badgeClass: "working"
  },
  success: {
    badge: "Finalizat",
    badgeClass: "success"
  },
  cancelled: {
    badge: "Anulat",
    badgeClass: "cancelled"
  },
  error: {
    badge: "Eroare",
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
  const fileName = selectedFile?.name ?? "Niciun fișier selectat";

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
        throw new Error(`Serverul a returnat JSON invalid (${response.status}).`);
      }

      throw new Error("Serverul a returnat un răspuns JSON invalid.");
    }
  }

  if (!response.ok) {
    const normalized = rawText.trim();

    if (response.status === 404 && normalized.startsWith("Not Found")) {
      throw new Error(
        "Endpoint-ul API nu a fost găsit. Pe Render, aplicația trebuie publicată ca Web Service, nu ca Static Site."
      );
    }

    throw new Error(normalized || `Cererea a eșuat (${response.status}).`);
  }

  if (!rawText.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error("Serverul a returnat un răspuns non-JSON.");
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
    return `${seconds}s scurse`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s scurse`;
}

function describeResult(result) {
  if (result.status === "queued") {
    return "Fișierul așteaptă pornirea procesării.";
  }

  if (result.status === "cancelling") {
    return "Se anulează cererea.";
  }

  if (result.status === "processing") {
    const parts = [];

    if (result.stage === "uploading_to_openai") {
      parts.push("Fișierul se încarcă pentru prelucrare.");
    } else if (result.stage === "uploaded_to_openai") {
      parts.push("Fișierul a fost încărcat și este pregătit pentru analiză.");
    } else if (result.stage === "response_created") {
      parts.push("Analiza a pornit.");
    } else if (result.stage === "waiting_for_openai") {
      parts.push("Se extrag etichetele și se pregătește fișierul final.");
    } else if (result.stage === "finalizing_output") {
      parts.push("Se finalizează rezultatul pentru descărcare.");
    } else {
      parts.push("Fișierul este în procesare.");
    }

    const elapsed = formatElapsed(result.elapsedSeconds);
    if (elapsed) {
      parts.push(elapsed);
    }

    return parts.join(" ");
  }

  if (result.status === "cancelled") {
    return "Analiza a fost anulată înainte de generarea fișierului.";
  }

  if (result.status === "failed") {
    return result.error || "Procesarea fișierului a eșuat.";
  }

  if (result.generatedFile) {
    return "Fișierul Excel este gata pentru descărcare.";
  }

  return "Procesarea s-a finalizat, dar fișierul Excel nu este disponibil.";
}

function renderEmptyState() {
  resultsElement.innerHTML = `
    <div class="empty-state">
      <strong>Nu există fișiere procesate încă.</strong>
      <span>Încarcă un fișier \`.xlsx\` pentru a începe generarea etichetelor.</span>
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
          ? "În așteptare"
          : result.status === "processing"
            ? "În procesare"
            : result.status === "cancelling"
              ? "Se anulează"
              : result.status === "completed"
                ? "Finalizat"
                : result.status === "cancelled"
                  ? "Anulat"
                  : "Eroare";

      const actions =
        result.status === "completed" && result.generatedFile
          ? `<a class="download-link" href="${escapeHtml(result.generatedFile.url)}" download="${escapeHtml(
              result.generatedFile.filename
            )}">Descarcă fișierul generat</a>`
          : result.status === "completed"
            ? '<span class="download-link disabled">Fișier Excel indisponibil</span>'
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
              <span class="result-label">Fișier procesat</span>
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
    panel.cancelButton.textContent = job?.status === "cancelling" ? "Se anulează..." : "Anulează analiza";
    panel.cancelButton.disabled = !canShow || job?.status === "cancelling";
  }
}

function updateStatusFromJob(job) {
  const primaryResult = Array.isArray(job.results) ? job.results[0] : null;

  if (job.status === "queued") {
    setStatus("Lucrarea este în așteptare. Fișierul este pregătit.", "working");
    setProcessState("processing");
    updateCancelButton(job);
    return;
  }

  if (job.status === "processing") {
    setStatus("Fișierul este în procesare.", "working");
    setProcessState("processing");
    updateCancelButton(job);
    return;
  }

  if (job.status === "cancelling") {
    setStatus("Se anulează cererea.", "working");
    setProcessState("processing");
    updateCancelButton(job);
    return;
  }

  if (job.status === "completed") {
    if (primaryResult?.generatedFile) {
      setStatus("Procesare finalizată. Fișierul este gata.", "success");
      setProcessState("success");
    } else {
      setStatus("Procesarea s-a finalizat, dar fișierul nu este disponibil.", "error");
      setProcessState("error");
    }
    updateCancelButton(null);
    return;
  }

  if (job.status === "completed_with_errors") {
    setStatus("Procesarea s-a finalizat cu erori.", "error");
    setProcessState("error");
    updateCancelButton(null);
    return;
  }

  if (job.status === "cancelled") {
    setStatus("Analiza a fost anulată.", "idle");
    setProcessState("cancelled");
    updateCancelButton(null);
    return;
  }

  setStatus("Lucrarea nu a putut fi finalizată.", "error");
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
      throw new Error(job.error || "Nu s-a putut citi starea procesării.");
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
      error instanceof Error ? error.message : "A apărut o problemă la actualizarea stării.",
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
      setStatus("Aplicația nu este configurată complet pentru procesare.", "error");
      setProcessState("error");
    }
  } catch {
    setStatus("Nu s-a putut verifica disponibilitatea aplicației.", "error");
    setProcessState("error");
  }
}

async function handleUploadSubmit(event) {
  event.preventDefault();

  const file = getSelectedFile();

  if (!file) {
    setStatus("Selectează un fișier `.xlsx`.", "error");
    setProcessState("idle");
    return;
  }

  stopPolling();
  activeJobId = null;
  updateCancelButton(null);

  const formData = new FormData();
  formData.append("files", file);

  setSubmitDisabled(true);
  setStatus("Fișierul este trimis spre procesare...", "working");
  setProcessState("processing");

  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      body: formData
    });
    const payload = await readApiPayload(response);

    if (!response.ok) {
      throw new Error(payload.error || "Cererea nu a putut fi procesată.");
    }

    activeJobId = payload.id;
    renderResults(payload.results || []);
    updateStatusFromJob(payload);
    void pollJob(payload.id);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Cererea a eșuat.", "error");
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
    panel.cancelButton.textContent = "Se anulează...";
  }

  setStatus("Se anulează cererea...", "working");

  try {
    const response = await fetch(`/api/jobs/${activeJobId}/cancel`, {
      method: "POST"
    });
    const payload = await readApiPayload(response);

    if (!response.ok) {
      throw new Error(payload.error || "Nu s-a putut anula analiza.");
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
    setStatus(error instanceof Error ? error.message : "Nu s-a putut anula analiza.", "error");
    updateCancelButton(activeJobId ? { id: activeJobId, status: "processing" } : null);
  }
}

function handleFileChange(fileInput) {
  syncFileInputs(fileInput);

  if (getSelectedFile()) {
    setProcessState("idle");
    setStatus("Fișierul este pregătit pentru procesare.", "idle");
  } else {
    selectedFile = null;
    updateFileNameDisplay();
    setProcessState("idle");
    setStatus("Selectează un fișier `.xlsx`.", "idle");
  }
}

for (const panel of uploadPanels) {
  panel.uploadForm?.addEventListener("submit", handleUploadSubmit);
  panel.cancelButton?.addEventListener("click", handleCancelClick);
  panel.fileInput?.addEventListener("change", () => {
    handleFileChange(panel.fileInput);
  });
}

updateFileNameDisplay();
updateCancelButton(null);
setProcessState("idle");
void loadHealth();
