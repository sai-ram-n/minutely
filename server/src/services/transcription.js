/**
 * Chunk transcription.
 *
 * The client records in ~20s chunks that deliberately overlap by ~1s, because
 * MediaRecorder cannot produce gapless standalone files — the overlap prevents
 * words being sliced in half at a boundary. The cost is duplicated words, which
 * dedupeOverlap() trims here.
 *
 * Chunks for one meeting are processed strictly in order even when their
 * transcription requests finish out of order, so the stored transcript never
 * scrambles.
 */

import { logger } from "../config/logger.js";
import {
  insertTranscriptLine,
  getLastTranscriptLine,
} from "./db.js";

/** @param {string} text */
function toWords(text) {
  return text.split(/\s+/).filter(Boolean);
}

/** Comparison form: case and punctuation should not defeat an overlap match. */
function normalizeWord(word) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * Removes the leading words of `newText` that repeat the trailing words of
 * `previousText`.
 *
 * Requires at least a two-word match: a single repeated word is very often
 * legitimate ("the ... the") rather than an artefact of the overlap.
 *
 * @param {string} previousText
 * @param {string} newText
 * @param {number} [maxWindow] Most words of overlap to consider.
 * @returns {string}
 */
export function dedupeOverlap(previousText, newText, maxWindow = 15) {
  if (!previousText || !newText) return newText;

  const previousWords = toWords(previousText).map(normalizeWord);
  const newWords = toWords(newText);
  const newWordsNormalized = newWords.map(normalizeWord);

  const limit = Math.min(maxWindow, previousWords.length, newWordsNormalized.length);

  // Longest match first: prefer trimming the largest genuine overlap.
  for (let size = limit; size >= 2; size -= 1) {
    const tail = previousWords.slice(previousWords.length - size);
    const head = newWordsNormalized.slice(0, size);

    const matches =
      tail.every((word, index) => word === head[index]) &&
      tail.some((word) => word.length > 0);

    if (matches) return newWords.slice(size).join(" ");
  }

  return newText;
}

/**
 * Serial queues, one per meeting.
 *
 * Transcription requests run concurrently, but their results must be applied in
 * chunk order. Chaining onto a per-meeting promise achieves that without
 * blocking other meetings.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const queues = new Map();

/**
 * @template T
 * @param {string} meetingId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function enqueue(meetingId, task) {
  const previous = queues.get(meetingId) ?? Promise.resolve();
  // Swallow the predecessor's rejection so one failed chunk cannot poison the
  // rest of the meeting's queue.
  const next = previous.catch(() => {}).then(task);
  queues.set(meetingId, next);

  next.catch(() => {}).finally(() => {
    if (queues.get(meetingId) === next) queues.delete(meetingId);
  });

  return next;
}

/** Drops a meeting's queue. Called when a meeting ends. */
export function clearQueue(meetingId) {
  queues.delete(meetingId);
}

/**
 * Transcribes one chunk and persists the resulting line.
 *
 * @param {Object} params
 * @param {import("../ai/provider.js").AiProvider} params.provider
 * @param {string} params.meetingId
 * @param {Buffer} params.audio
 * @param {number} params.sequence
 * @param {string} [params.mimeType]
 * @param {number} [params.startOffsetMs]
 * @param {(text: string, segments: import("../ai/provider.js").TranscriptSegment[] | undefined) => string} [params.labelFor]
 *   Supplied by turn detection; defaults to a single speaker.
 * @returns {Promise<import("./db.js").TranscriptLineRow | null>}
 *   null when the chunk produced nothing worth storing (silence, or entirely
 *   duplicated overlap).
 */
export async function transcribeChunk({
  provider,
  meetingId,
  audio,
  sequence,
  mimeType,
  startOffsetMs,
  labelFor,
}) {
  const result = await provider.transcribe(audio, { mimeType });
  const rawText = (result.text ?? "").trim();

  if (rawText === "") {
    logger.debug({ meetingId, sequence }, "chunk transcribed to silence — nothing stored");
    return null;
  }

  const previous = await getLastTranscriptLine(meetingId);
  const text = dedupeOverlap(previous?.text ?? "", rawText).trim();

  if (text === "") {
    logger.debug(
      { meetingId, sequence },
      "chunk was entirely overlap with the previous line — nothing stored",
    );
    return null;
  }

  const speakerLabel = labelFor
    ? labelFor(text, result.segments)
    : "Speaker 1";

  const line = await insertTranscriptLine({
    meetingId,
    speakerLabel,
    text,
    sequence,
    timestamp: new Date().toISOString(),
  });

  logger.debug(
    { meetingId, sequence, chars: text.length, startOffsetMs },
    "transcript line stored",
  );

  return line;
}
