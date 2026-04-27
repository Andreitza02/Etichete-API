import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import OpenAI, { toFile } from "openai";

import { config } from "./config.js";
import { buildSuggestedOutputName, buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import {
  extractResponseText,
  findGeneratedWorkbookCitation,
  parseTaggedResponse,
  sanitizeFilename
} from "./utils.js";

const client = new OpenAI({
  apiKey: config.openaiApiKey || undefined,
  timeout: config.openaiTimeoutMs
});

const FINAL_STATUSES = new Set(["completed", "failed", "cancelled", "incomplete"]);

export class ProcessingCancelledError extends Error {
  constructor(message = "Analiza a fost anulată.") {
    super(message);
    this.name = "ProcessingCancelledError";
  }
}

function assertConfigured() {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
}

function throwIfCancelled(isCancelled) {
  if (isCancelled?.()) {
    throw new ProcessingCancelledError();
  }
}

async function waitForResponseCompletion(responseId, onProgress, isCancelled) {
  const startedAt = Date.now();
  const deadline = Date.now() + config.responseTimeoutMs;
  let cancellationRequested = false;

  while (true) {
    if (isCancelled?.() && !cancellationRequested) {
      cancellationRequested = true;
      onProgress?.({
        stage: "cancelling",
        responseId,
        openaiStatus: "cancelling",
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000)
      });
      await client.responses.cancel(responseId).catch(() => {});
    }

    const response = await client.responses.retrieve(responseId);
    onProgress?.({
      stage: "waiting_for_openai",
      responseId,
      openaiStatus: response.status,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000)
    });

    if (response.status === "cancelled") {
      throw new ProcessingCancelledError();
    }

    if (FINAL_STATUSES.has(response.status)) {
      return response;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for response ${responseId} to complete.`);
    }

    await delay(config.pollIntervalMs);
  }
}

function getFailureMessage(response) {
  if (response.error?.message) {
    return response.error.message;
  }

  if (response.incomplete_details?.reason) {
    return `Response finished with status "${response.status}" (${response.incomplete_details.reason}).`;
  }

  return `Response finished with status "${response.status}".`;
}

async function downloadContainerFile({ containerId, fileId }) {
  const response = await fetch(
    `https://api.openai.com/v1/containers/${containerId}/files/${fileId}/content`,
    {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`
      }
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unable to download generated workbook (${response.status}): ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function findGeneratedWorkbookInContainers(response, preferredFilename) {
  const containerIds = [];

  for (const item of response.output ?? []) {
    if (item?.type !== "code_interpreter_call" || typeof item.container_id !== "string") {
      continue;
    }

    if (!containerIds.includes(item.container_id)) {
      containerIds.push(item.container_id);
    }
  }

  for (const containerId of containerIds) {
    const page = await client.containers.files.list(containerId, { limit: 100 });
    const files = (page.data ?? []).filter(
      (file) => typeof file.path === "string" && file.path.toLowerCase().endsWith(".xlsx")
    );

    if (preferredFilename) {
      const exactMatch = files.find(
        (file) => path.basename(file.path).toLowerCase() === preferredFilename.toLowerCase()
      );

      if (exactMatch) {
        return {
          containerId,
          fileId: exactMatch.id,
          filename: path.basename(exactMatch.path)
        };
      }
    }

    const assistantFiles = files
      .filter((file) => file.source === "assistant")
      .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));

    if (assistantFiles.length) {
      const match = assistantFiles[0];

      return {
        containerId,
        fileId: match.id,
        filename: path.basename(match.path)
      };
    }
  }

  return null;
}

export async function cancelOpenAIResponse(responseId) {
  assertConfigured();
  return client.responses.cancel(responseId);
}

export async function processWorkbook({
  localPath,
  originalName,
  onlyTerminals,
  onProgress,
  isCancelled
}) {
  assertConfigured();
  const uploadFilename = path.basename(originalName);
  const uploadFile = await toFile(fs.createReadStream(localPath), uploadFilename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  throwIfCancelled(isCancelled);
  onProgress?.({
    stage: "uploading_to_openai",
    openaiStatus: "uploading"
  });

  const uploadedFile = await client.files.create({
    file: uploadFile,
    purpose: "user_data"
  });
  onProgress?.({
    stage: "uploaded_to_openai",
    openaiStatus: "uploaded"
  });

  try {
    throwIfCancelled(isCancelled);
    const initialResponse = await client.responses.create({
      model: config.openaiModel,
      background: true,
      reasoning: {
        effort: config.reasoningEffort
      },
      tools: [
        {
          type: "code_interpreter",
          container: {
            type: "auto",
            memory_limit: "4g"
          }
        }
      ],
      tool_choice: "required",
      instructions: SYSTEM_PROMPT,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file_id: uploadedFile.id
            },
            {
              type: "input_text",
              text: buildUserPrompt({ originalName, onlyTerminals })
            }
          ]
        }
      ]
    });
    onProgress?.({
      stage: "response_created",
      responseId: initialResponse.id,
      openaiStatus: initialResponse.status,
      elapsedSeconds: 0
    });

    if (isCancelled?.() && !FINAL_STATUSES.has(initialResponse.status)) {
      await client.responses.cancel(initialResponse.id).catch(() => {});
    }

    const completedResponse = FINAL_STATUSES.has(initialResponse.status)
      ? initialResponse
      : await waitForResponseCompletion(initialResponse.id, onProgress, isCancelled);

    if (completedResponse.status === "cancelled") {
      throw new ProcessingCancelledError();
    }

    if (completedResponse.status !== "completed") {
      throw new Error(getFailureMessage(completedResponse));
    }
    onProgress?.({
      stage: "finalizing_output",
      responseId: completedResponse.id,
      openaiStatus: completedResponse.status
    });

    const responseText = extractResponseText(completedResponse);

    if (!responseText) {
      throw new Error("Model completed without returning text output.");
    }

    const { markdown, outputFilename } = parseTaggedResponse(responseText);
    const citation = findGeneratedWorkbookCitation(completedResponse, outputFilename);
    const generatedWorkbook =
      citation ||
      (outputFilename.toUpperCase() !== "NONE"
        ? await findGeneratedWorkbookInContainers(completedResponse, outputFilename)
        : null);

    let generatedFile = null;

    if (generatedWorkbook && outputFilename.toUpperCase() !== "NONE") {
      const buffer = await downloadContainerFile(generatedWorkbook);
      const publicFilename = sanitizeFilename(
        outputFilename || generatedWorkbook.filename || buildSuggestedOutputName(originalName)
      );
      const storageFilename = `${randomUUID()}-${publicFilename}`;
      const storagePath = path.join(config.generatedDir, storageFilename);

      await writeFile(storagePath, buffer);

      generatedFile = {
        filename: publicFilename,
        storageFilename,
        url: `/downloads/${encodeURIComponent(storageFilename)}`
      };
    }
    onProgress?.({
      stage: "completed",
      responseId: completedResponse.id,
      openaiStatus: completedResponse.status
    });

    return {
      markdown,
      generatedFile,
      responseId: completedResponse.id
    };
  } finally {
    await client.files.delete(uploadedFile.id).catch(() => {});
  }
}
