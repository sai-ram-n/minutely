/**
 * The AiProvider contract.
 *
 * There is no TypeScript here, so the "interface" is a documented shape plus a
 * runtime check — both matter. Every AI call in the codebase goes through this
 * shape, and every retry, backoff and rate-limit concern lives inside the
 * implementation rather than being scattered through route or socket handlers.
 *
 * Swapping providers (e.g. Groq -> Gemini, should Groq's free tier ever change)
 * means adding one new file that matches this shape and pointing config at it.
 * Nothing else in the codebase changes.
 */

import { z } from "zod";

/**
 * One segment of transcribed audio with its timing, used by turn detection to
 * infer speaker boundaries from silence gaps.
 *
 * @typedef {Object} TranscriptSegment
 * @property {number} start  Seconds from the start of this audio chunk
 * @property {number} end    Seconds from the start of this audio chunk
 * @property {string} text
 */

/**
 * @typedef {Object} TranscriptionResult
 * @property {string} text
 * @property {TranscriptSegment[]} [segments]
 *   Optional. Present when the provider can report per-segment timings.
 *   Turn detection uses these; a provider without them still satisfies the
 *   contract and simply yields no speaker boundaries within a chunk.
 */

/**
 * @typedef {Object} ActionItem
 * @property {string} task
 * @property {string} owner  "Unassigned" when the transcript does not say
 * @property {string} due    "Not specified" when the transcript does not say
 */

/**
 * @typedef {Object} MinutesResult
 * @property {string[]} decisions
 * @property {ActionItem[]} action_items
 * @property {string[]} open_questions
 */

/**
 * @typedef {Object} AiProvider
 * @property {string} name  Identifier for logs, e.g. "groq"
 * @property {(audioChunk: Buffer, options?: { mimeType?: string }) => Promise<TranscriptionResult>} transcribe
 * @property {(transcript: string) => Promise<MinutesResult>} summarize
 */

/** Runtime schema for whatever an LLM hands back. Never trust it unvalidated. */
export const actionItemSchema = z.object({
  task: z.string().min(1),
  owner: z.string().min(1).default("Unassigned"),
  due: z.string().min(1).default("Not specified"),
});

export const minutesSchema = z.object({
  decisions: z.array(z.string().min(1)),
  action_items: z.array(actionItemSchema),
  open_questions: z.array(z.string().min(1)),
});

/**
 * Verifies an object actually implements the provider contract.
 *
 * Cheap insurance against a typo producing a provider with a missing or
 * misspelled method, which would otherwise surface as a confusing
 * "x is not a function" at the worst possible moment. Called once at startup.
 *
 * @param {unknown} provider
 * @returns {AiProvider}
 */
export function assertValidProvider(provider) {
  if (provider === null || typeof provider !== "object") {
    throw new Error(
      `AiProvider implementation must be an object, received ${provider === null ? "null" : typeof provider}`,
    );
  }

  /** @type {Record<string, unknown>} */
  const candidate = provider;
  const missing = [];

  if (typeof candidate.transcribe !== "function") missing.push("transcribe()");
  if (typeof candidate.summarize !== "function") missing.push("summarize()");

  if (missing.length > 0) {
    throw new Error(
      `AiProvider implementation missing ${missing.join(" and ")}`,
    );
  }

  return /** @type {AiProvider} */ (provider);
}

/**
 * Validates and normalises a summarization result.
 *
 * Applies defaults for owner/due so the UI never has to render "undefined", and
 * throws a readable error if the model returned something structurally wrong —
 * which the caller turns into a retry, and ultimately into a `failed` meeting
 * rather than a silent dead end.
 *
 * @param {unknown} raw
 * @returns {MinutesResult}
 */
export function parseMinutes(raw) {
  const result = minutesSchema.safeParse(raw);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Summarization returned an unexpected shape — ${detail}`);
  }

  return result.data;
}
