import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({ override: true, quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  projectRoot,
  port: toInt(process.env.PORT, 3000),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.5",
  reasoningEffort: process.env.OPENAI_REASONING_EFFORT || "medium",
  openaiTimeoutMs: toInt(process.env.OPENAI_TIMEOUT_MS, 900000),
  responseTimeoutMs: toInt(process.env.RESPONSE_TIMEOUT_MS, 900000),
  pollIntervalMs: toInt(process.env.POLL_INTERVAL_MS, 3000),
  uploadLimitBytes: 50 * 1024 * 1024,
  uploadsDir: path.join(projectRoot, "storage", "uploads"),
  generatedDir: path.join(projectRoot, "storage", "generated")
};
