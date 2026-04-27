# Etichete API

Web app for uploading `.xlsx` workbooks, sending them to the OpenAI Responses API with `gpt-5.5`, `reasoning.effort: medium`, and `code_interpreter`, then returning:

- Output A as plain text grouped markdown
- Output B as a generated `.xlsx` workbook for download

## What is included

- Browser UI for uploading one or more `.xlsx` files
- Optional `onlyTerminals` mode
- OpenAI Responses API integration with polling for long-running jobs
- Code Interpreter file download handling for generated workbooks
- Your extraction rules stored in `prompts/extraction-rules.md`

## Requirements

- Node.js 20+
- An OpenAI API key with access to `gpt-5.5`

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from `.env.example` and set your API key:

   ```env
   OPENAI_API_KEY=your_key_here
   OPENAI_MODEL=gpt-5.5
   OPENAI_REASONING_EFFORT=medium
   PORT=3000
   OPENAI_TIMEOUT_MS=900000
   RESPONSE_TIMEOUT_MS=900000
   POLL_INTERVAL_MS=3000
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:3000`

If port `3000` is already in use, set `PORT` in `.env` to another value such as `3100`.

## API

### `GET /api/health`

Returns current model and configuration status.

### `POST /api/extract`

Multipart form upload:

- `files`: one or more `.xlsx` files
- `onlyTerminals`: optional boolean-like string

Returns `202 Accepted` with a background job payload. Poll the job endpoint below for progress and results.

### `GET /api/jobs/:jobId`

Returns the current job state, aggregate totals, and per-file results.

Each result item contains:

- `inputFilename`
- `success`
- `status`
- `markdown`
- `generatedFile.url`
- `generatedFile.filename`
- `responseId`

## Notes

- The app accepts only `.xlsx`.
- Uploads are processed asynchronously; the browser polls for job status while OpenAI is working.
- Generated output workbooks are stored temporarily in `storage/generated/`.
- Uploaded temp files are deleted after each request finishes.
- If the model returns markdown but no generated workbook citation, the text result is still returned.
