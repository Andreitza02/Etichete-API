import { mkdir } from "node:fs/promises";

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export function sanitizeFilename(filename) {
  return (
    filename
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.+$/, "") || "output.xlsx"
  );
}

export function extractResponseText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts = [];

  for (const item of response.output ?? []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

export function parseTaggedResponse(text) {
  const markdownMatch = text.match(/<<MARKDOWN>>\s*([\s\S]*?)\s*<<\/MARKDOWN>>/);
  const outputFileMatch = text.match(
    /<<OUTPUT_XLSX_FILENAME>>\s*([\s\S]*?)\s*<<\/OUTPUT_XLSX_FILENAME>>/
  );

  if (!markdownMatch) {
    throw new Error("Model response did not include the <<MARKDOWN>> block.");
  }

  return {
    markdown: markdownMatch[1].replace(/^\n+|\n+$/g, ""),
    outputFilename: outputFileMatch?.[1]?.trim() || ""
  };
}

export function findGeneratedWorkbookCitation(response, preferredFilename) {
  const candidates = [];

  for (const item of response.output ?? []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const content of item.content ?? []) {
      if (content?.type !== "output_text") {
        continue;
      }

      const annotations = Array.isArray(content.annotations) ? content.annotations : [];

      for (const annotation of annotations) {
        if (annotation?.type !== "container_file_citation") {
          continue;
        }

        const annotatedText =
          typeof content.text === "string" &&
          Number.isInteger(annotation.start_index) &&
          Number.isInteger(annotation.end_index)
            ? content.text.slice(annotation.start_index, annotation.end_index)
            : "";

        candidates.push({
          containerId: annotation.container_id,
          fileId: annotation.file_id,
          filename: annotation.filename || annotatedText || preferredFilename || "output.xlsx"
        });
      }
    }
  }

  if (!candidates.length) {
    return null;
  }

  if (preferredFilename) {
    const exactMatch = candidates.find(
      (candidate) => candidate.filename.toLowerCase() === preferredFilename.toLowerCase()
    );

    if (exactMatch) {
      return exactMatch;
    }
  }

  return (
    candidates.find((candidate) => candidate.filename.toLowerCase().endsWith(".xlsx")) ||
    candidates[0]
  );
}
