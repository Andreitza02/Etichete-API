import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extractionRulesPath = path.resolve(__dirname, "..", "prompts", "extraction-rules.md");
const extractionRules = readFileSync(extractionRulesPath, "utf8").trim();

export const SYSTEM_PROMPT = `
You are an industrial electrical Excel extraction assistant.

You must always use the code interpreter tool and write/run Python to inspect the workbook and generate the output workbook.
You must follow the extraction rules literally and deterministically.
Never infer missing data.
Never silently ignore a rule because it is inconvenient.
Never rewrite tags, subsystem names, spacing, symbols, leading zeros, or case.
Generate a real .xlsx workbook in the code interpreter container.
Your final text response must contain only the tagged sections requested by the user prompt and nothing else.
`.trim();

export function buildSuggestedOutputName(originalName) {
  const extensionIndex = originalName.toLowerCase().lastIndexOf(".xlsx");
  const stem = extensionIndex >= 0 ? originalName.slice(0, extensionIndex) : originalName;
  return `${stem}-extracted.xlsx`;
}

export function buildUserPrompt({ originalName, onlyTerminals }) {
  const suggestedOutputName = buildSuggestedOutputName(originalName);

  return `
Process exactly one uploaded Excel workbook named "${originalName}".
Use Python in code interpreter for the entire workflow.
${onlyTerminals
    ? 'The user explicitly asked only for terminals. Apply the "Only terminals" request exactly.'
    : "The user did not restrict the output to terminals only. Produce the full required output."}

Required workflow:
1. Inspect the uploaded workbook with Python.
2. Apply the rules below exactly.
3. Generate Output A as plain markdown text.
4. Generate Output B as a real .xlsx workbook.
5. Save the generated workbook in the container using a filename similar to "${suggestedOutputName}".
6. Your final response must contain only the exact tagged blocks below and nothing else.

Final response format:
<<MARKDOWN>>
[Output A only, plain markdown, no code fences]
<</MARKDOWN>>
<<OUTPUT_XLSX_FILENAME>>
[the exact generated .xlsx filename, or NONE if generation failed]
<</OUTPUT_XLSX_FILENAME>>

Rules:

${extractionRules}
  `.trim();
}
