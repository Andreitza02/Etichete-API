import path from "node:path";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import express from "express";
import multer from "multer";

import { config } from "./config.js";
import {
  cancelOpenAIResponse,
  processWorkbook,
  ProcessingCancelledError
} from "./openai-service.js";
import { ensureDir } from "./utils.js";

await ensureDir(config.uploadsDir);
await ensureDir(config.generatedDir);

const app = express();
const jobs = new Map();

const upload = multer({
  dest: config.uploadsDir,
  limits: {
    fileSize: config.uploadLimitBytes
  },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== ".xlsx") {
      cb(new Error("Only .xlsx files are accepted."));
      return;
    }

    cb(null, true);
  }
});

app.use(express.json());
app.use("/downloads", express.static(config.generatedDir, { index: false }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(config.openaiApiKey),
    model: config.openaiModel,
    reasoningEffort: config.reasoningEffort
  });
});

function touchJob(job) {
  job.updatedAt = new Date().toISOString();
}

function isTerminalResultStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalJobStatus(status) {
  return (
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function cancelPendingResults(job, reason = "Analiza a fost anulată.") {
  const now = new Date().toISOString();

  for (const result of job.results) {
    if (isTerminalResultStatus(result.status)) {
      continue;
    }

    Object.assign(result, {
      status: "cancelled",
      success: false,
      error: reason,
      stage: "cancelled",
      openaiStatus: result.openaiStatus === "cancelled" ? result.openaiStatus : "cancelled",
      completedAt: result.completedAt ?? now,
      lastCheckedAt: now
    });
  }
}

function finalizeJob(job) {
  const hasFailed = job.results.some((result) => result.status === "failed");
  const hasCompleted = job.results.some((result) => result.status === "completed");
  const hasCancelled = job.results.some((result) => result.status === "cancelled");

  if (hasFailed) {
    job.status = "completed_with_errors";
  } else if (hasCancelled && !hasCompleted) {
    job.status = "cancelled";
  } else if (hasCancelled) {
    job.status = "completed_with_errors";
  } else {
    job.status = "completed";
  }

  job.completedAt = new Date().toISOString();
  touchJob(job);
}

function serializeJob(job) {
  const results = job.results.map((result) => ({ ...result }));
  const completedCount = results.filter((result) => isTerminalResultStatus(result.status)).length;
  const successCount = results.filter((result) => result.status === "completed").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const cancelledCount = results.filter((result) => result.status === "cancelled").length;

  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    cancelRequested: job.cancelRequested,
    onlyTerminals: job.onlyTerminals,
    totals: {
      total: results.length,
      completed: completedCount,
      succeeded: successCount,
      failed: failedCount,
      cancelled: cancelledCount
    },
    results
  };
}

async function runJob(jobId, files) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  if (job.cancelRequested) {
    cancelPendingResults(job);

    for (const file of files) {
      await unlink(file.path).catch(() => {});
    }

    finalizeJob(job);
    return;
  }

  job.status = "processing";
  touchJob(job);

  try {
    for (const [index, file] of files.entries()) {
      const result = job.results[index];

      if (job.cancelRequested) {
        Object.assign(result, {
          status: "cancelled",
          success: false,
          error: "Analiza a fost anulată.",
          stage: "cancelled",
          openaiStatus: result.openaiStatus === "cancelled" ? result.openaiStatus : "cancelled",
          completedAt: new Date().toISOString()
        });
        touchJob(job);
        await unlink(file.path).catch(() => {});
        continue;
      }

      result.status = "processing";
      result.startedAt = new Date().toISOString();
      touchJob(job);

      try {
        const processed = await processWorkbook({
          localPath: file.path,
          originalName: file.originalname,
          onlyTerminals: job.onlyTerminals,
          isCancelled: () => job.cancelRequested,
          onProgress: (progress) => {
            Object.assign(result, {
              status:
                job.cancelRequested && result.status !== "cancelled" ? "cancelling" : result.status,
              stage: progress.stage ?? result.stage,
              openaiStatus: progress.openaiStatus ?? result.openaiStatus,
              responseId: progress.responseId ?? result.responseId,
              elapsedSeconds: progress.elapsedSeconds ?? result.elapsedSeconds,
              lastCheckedAt: new Date().toISOString()
            });

            if (job.cancelRequested && !isTerminalJobStatus(job.status)) {
              job.status = "cancelling";
            }

            touchJob(job);
          }
        });

        Object.assign(result, {
          status: "completed",
          success: true,
          ...processed,
          completedAt: new Date().toISOString()
        });
      } catch (error) {
        if (error instanceof ProcessingCancelledError) {
          Object.assign(result, {
            status: "cancelled",
            success: false,
            error: error.message,
            stage: "cancelled",
            openaiStatus: result.openaiStatus === "cancelled" ? result.openaiStatus : "cancelled",
            completedAt: new Date().toISOString()
          });
        } else {
          Object.assign(result, {
            status: "failed",
            success: false,
            error: error instanceof Error ? error.message : "Unknown error.",
            completedAt: new Date().toISOString()
          });
        }
      } finally {
        touchJob(job);
        await unlink(file.path).catch(() => {});
      }
    }

    finalizeJob(job);
  } catch (error) {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.error = error instanceof Error ? error.message : "Unexpected job failure.";
    touchJob(job);
  }
}

app.post("/api/extract", upload.single("files"), async (req, res) => {
  const files = req.file ? [req.file] : [];
  const requestBody = req.body ?? {};
  const onlyTerminals =
    requestBody.onlyTerminals === "true" || requestBody.onlyTerminals === "on";

  if (!files.length) {
    res.status(400).json({
      error: "Upload one .xlsx workbook."
    });
    return;
  }

  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelRequested: false,
    onlyTerminals,
    results: files.map((file) => ({
      inputFilename: file.originalname,
      status: "queued",
      success: null,
      stage: "queued",
      openaiStatus: null,
      elapsedSeconds: 0,
      lastCheckedAt: null,
      markdown: "",
      generatedFile: null,
      error: null,
      responseId: null,
      startedAt: null,
      completedAt: null
    }))
  };

  jobs.set(job.id, job);
  void runJob(job.id, files);

  res.status(202).json(serializeJob(job));
});

app.post("/api/jobs/:jobId/cancel", async (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    res.status(404).json({
      error: "Job not found."
    });
    return;
  }

  if (isTerminalJobStatus(job.status)) {
    res.json(serializeJob(job));
    return;
  }

  job.cancelRequested = true;
  job.status = "cancelling";

  for (const result of job.results) {
    if (isTerminalResultStatus(result.status)) {
      continue;
    }

    result.status = "cancelling";
    result.stage = "cancelling";
    result.lastCheckedAt = new Date().toISOString();
  }

  const activeResponseId = job.results.find((result) => typeof result.responseId === "string")
    ?.responseId;

  if (activeResponseId) {
    try {
      const cancelledResponse = await cancelOpenAIResponse(activeResponseId);
      const activeResult = job.results.find((result) => result.responseId === activeResponseId);

      if (activeResult) {
        activeResult.openaiStatus = cancelledResponse.status;
        activeResult.lastCheckedAt = new Date().toISOString();
      }
    } catch (error) {
      const activeResult = job.results.find((result) => result.responseId === activeResponseId);

      if (activeResult && activeResult.error == null) {
        activeResult.error = error instanceof Error ? error.message : "OpenAI cancellation failed.";
      }
    }
  }

  touchJob(job);
  res.json(serializeJob(job));
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    res.status(404).json({
      error: "Job not found."
    });
    return;
  }

  res.json(serializeJob(job));
});

app.use("/api", (_req, res) => {
  res.status(404).json({
    error: "API endpoint not found."
  });
});

app.use(express.static(path.join(config.projectRoot, "public")));

app.use((error, _req, res, _next) => {
  const isUploadError =
    error instanceof multer.MulterError ||
    error?.message === "Only .xlsx files are accepted.";

  res.status(isUploadError ? 400 : 500).json({
    error: error instanceof Error ? error.message : "Unexpected server error."
  });
});

const server = app.listen(config.port, () => {
  console.log(`Etichete API running at http://localhost:${config.port}`);
});

export { app, server };
