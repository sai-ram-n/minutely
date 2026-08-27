/**
 * Groq implementation of the AiProvider contract.
 *
 * Uses whisper-large-v3-turbo for transcription and a configurable chat model
 * for summarization. All retry, backoff and rate-limit handling is contained
 * here (via ai/retry.js) — callers just await and handle a final failure.
 *
 * The API key never leaves this module and is never logged.
 */

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { withRetry, HttpError } from "./retry.js";
import { parseMinutes } from "./provider.js";
import { buildSummaryMessages } from "./prompts.js";

/** Groq returns Retry-After in seconds on 429. Honour it over our own guess. */
function parseRetryAfter(headers) {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Turns a non-OK response into an HttpError carrying the status, so retry
 * decisions are made on status rather than by string-matching.
 * @param {Response} response
 */
async function toHttpError(response) {
  let body = "";
  try {
    body = (await response.text()).slice(0, 500);
  } catch {
    body = "(response body unreadable)";
  }

  return new HttpError(
    response.status,
    `Groq API responded ${response.status} ${response.statusText}`,
    { retryAfterSeconds: parseRetryAfter(response.headers), body },
  );
}

/**
 * Creates a Groq-backed provider.
 *
 * @param {Object} [overrides] Injected by tests so no real network call is made.
 * @param {typeof fetch} [overrides.fetchImpl]
 * @param {(ms: number) => Promise<void>} [overrides.sleep]
 * @param {Object} [overrides.config]
 * @returns {import("./provider.js").AiProvider}
 */
export function createGroqProvider(overrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const sleep = overrides.sleep;

  const config = {
    apiKey: env.GROQ_API_KEY,
    baseUrl: env.GROQ_BASE_URL,
    transcribeModel: env.GROQ_TRANSCRIBE_MODEL,
    summaryModel: env.GROQ_SUMMARY_MODEL,
    timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    ...overrides.config,
  };

  /** Shared retry settings: 3 attempts, 1s base, doubling. */
  const retryOptions = {
    attempts: 3,
    baseDelayMs: 1000,
    ...(sleep ? { sleep } : {}),
    ...(overrides.retryOptions ?? {}),
    onRetry: ({ attempt, attempts, delayMs, error }) => {
      logger.warn(
        {
          attempt,
          attempts,
          delayMs: Math.round(delayMs),
          status: error instanceof HttpError ? error.status : undefined,
        },
        "Groq request failed — backing off and retrying",
      );
    },
  };

  /**
   * One HTTP call with a hard timeout. The timeout is per attempt, so a hung
   * connection cannot stall the whole retry sequence indefinitely.
   * @param {string} path
   * @param {RequestInit} init
   */
  async function request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(init.headers ?? {}),
        },
      });

      if (!response.ok) throw await toHttpError(response);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "groq",

    /**
     * @param {Buffer} audioChunk
     * @param {{ mimeType?: string, filename?: string }} [options]
     * @returns {Promise<import("./provider.js").TranscriptionResult>}
     */
    async transcribe(audioChunk, options = {}) {
      if (!audioChunk || audioChunk.length === 0) {
        throw new Error("transcribe() received an empty audio chunk");
      }

      const mimeType = options.mimeType ?? "audio/webm";
      const filename = options.filename ?? "chunk.webm";

      return withRetry(async () => {
        const form = new FormData();
        form.append("file", new Blob([audioChunk], { type: mimeType }), filename);
        form.append("model", config.transcribeModel);
        // verbose_json gives per-segment timings, which turn detection uses to
        // infer speaker boundaries from silence gaps.
        form.append("response_format", "verbose_json");
        form.append("temperature", "0");

        const response = await request("/audio/transcriptions", {
          method: "POST",
          body: form,
        });

        const data = await response.json();

        return {
          text: typeof data.text === "string" ? data.text.trim() : "",
          segments: Array.isArray(data.segments)
            ? data.segments.map((segment) => ({
                start: Number(segment.start) || 0,
                end: Number(segment.end) || 0,
                text: String(segment.text ?? "").trim(),
              }))
            : undefined,
        };
      }, retryOptions);
    },

    /**
     * @param {string} transcript
     * @returns {Promise<import("./provider.js").MinutesResult>}
     */
    async summarize(transcript) {
      if (typeof transcript !== "string" || transcript.trim().length === 0) {
        throw new Error("summarize() received an empty transcript");
      }

      return withRetry(async () => {
        const response = await request("/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.summaryModel,
            messages: buildSummaryMessages(transcript),
            // Ask the API itself to guarantee JSON rather than hoping the
            // prompt is obeyed. Still validated below — never trust it blind.
            response_format: { type: "json_object" },
            temperature: 0.2,
          }),
        });

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;

        if (typeof content !== "string" || content.trim() === "") {
          throw new Error("Groq returned an empty summarization response");
        }

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch {
          // Malformed JSON is worth another attempt: it is usually a one-off
          // sampling artefact rather than a permanent failure.
          throw new HttpError(500, "Groq returned unparseable JSON for summarization");
        }

        return parseMinutes(parsed);
      }, retryOptions);
    },
  };
}
