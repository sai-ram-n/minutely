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
  getNextLineSequence,
} from "./db.js";
import {
  detectTurns,
  initialTurnState,
  speakerLabel,
  speakerIndexFromLabel,
} from "./turnDetection.js";

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
 * Whether transcribed text contains anything worth storing.
 *
 * Whisper returns a bare "." or "..." for a chunk of near-silence — not an
 * empty string, so a trim-only check lets it through and it shows up in the
 * transcript as a line containing a full stop. Observed in a real four-minute
 * recording: two such lines at the end, after the audio ran out.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasSpeech(text) {
  return /[\p{L}\p{N}]/u.test(String(text ?? ""));
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
 * Turn-detection state per meeting.
 *
 * Held in memory because it is only meaningful during a live recording. If it
 * is missing — a restart mid-meeting — it is rebuilt from the last stored line
 * so speakers do not silently reset to Speaker 1.
 *
 * @type {Map<string, import("./turnDetection.js").TurnState>}
 */
const turnStates = new Map();

/**
 * @param {string} meetingId
 * @param {import("./db.js").TranscriptLineRow | null} lastLine
 * @returns {import("./turnDetection.js").TurnState}
 */
function turnStateFor(meetingId, lastLine) {
  const existing = turnStates.get(meetingId);
  if (existing) return existing;

  const state = lastLine
    ? { speakerIndex: speakerIndexFromLabel(lastLine.speaker_label), lastEndMs: null }
    : initialTurnState();

  turnStates.set(meetingId, state);
  return state;
}

/** Forgets a meeting's turn state. Called when the meeting ends. */
export function clearTurnState(meetingId) {
  turnStates.delete(meetingId);
}

/**
 * Transcribes one chunk and persists the resulting transcript lines.
 *
 * A chunk may contain more than one speaker turn, so this returns an array.
 * Line sequence is independent of chunk sequence for exactly that reason.
 *
 * @param {Object} params
 * @param {import("../ai/provider.js").AiProvider} params.provider
 * @param {string} params.meetingId
 * @param {Buffer} params.audio
 * @param {number} params.sequence Chunk sequence, for logging only
 * @param {string} [params.mimeType]
 * @param {number} [params.startOffsetMs]
 * @param {number} [params.gapThresholdMs]
 * @param {number} [params.speakerCount]
 * @returns {Promise<import("./db.js").TranscriptLineRow[]>}
 */
export async function transcribeChunk({
  provider,
  meetingId,
  audio,
  sequence,
  mimeType,
  startOffsetMs = 0,
  gapThresholdMs,
  speakerCount,
}) {
  const result = await provider.transcribe(audio, { mimeType });
  const rawText = (result.text ?? "").trim();

  if (!hasSpeech(rawText)) {
    logger.debug({ meetingId, sequence }, "chunk transcribed to silence — nothing stored");
    return [];
  }

  const previous = await getLastTranscriptLine(meetingId);
  const state = turnStateFor(meetingId, previous);

  const { turns, state: nextState } = detectTurns(result.segments, {
    state,
    startOffsetMs,
    gapThresholdMs,
    speakerCount,
    fallbackText: rawText,
  });

  turnStates.set(meetingId, nextState);

  if (turns.length === 0) return [];

  // The chunks deliberately overlap, so the first turn may repeat the tail of
  // the previous line. Only the first turn can be affected.
  const previousText = previous?.text ?? "";
  turns[0].text = dedupeOverlap(previousText, turns[0].text).trim();

  const storable = turns.filter((turn) => hasSpeech(turn.text));

  if (storable.length === 0) {
    logger.debug(
      { meetingId, sequence },
      "chunk was entirely overlap with the previous line — nothing stored",
    );
    return [];
  }

  let nextSequence = await getNextLineSequence(meetingId);
  const stored = [];

  for (const turn of storable) {
    const line = await insertTranscriptLine({
      meetingId,
      speakerLabel: speakerLabel(turn.speakerIndex),
      text: turn.text,
      sequence: nextSequence,
      timestamp: new Date().toISOString(),
    });

    stored.push(line);
    nextSequence += 1;
  }

  logger.debug(
    { meetingId, chunk: sequence, turns: stored.length, startOffsetMs },
    "transcript lines stored",
  );

  return stored;
}
