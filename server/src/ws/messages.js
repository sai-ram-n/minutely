/**
 * WebSocket protocol schemas.
 *
 * Every inbound message is parsed through zod before any handler touches it, so
 * a malformed or hostile payload becomes a clean error reply rather than a
 * crashed server. Nothing downstream needs defensive checks.
 */

import { z } from "zod";

/**
 * A 20s Opus chunk is roughly 50–150 KB. 2 MB decoded is far above anything
 * legitimate while still bounding what a bad actor can push through in one
 * message — and, more importantly, what gets forwarded to a metered API.
 */
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

/** base64 inflates by 4/3; leave headroom for the JSON envelope. */
export const MAX_SOCKET_PAYLOAD_BYTES = 3 * 1024 * 1024;

const meetingId = z.string().uuid("meetingId must be a UUID");

/** Rejects non-base64 early, before allocating a Buffer for it. */
const base64Audio = z
  .string()
  .min(1, "audio chunk is empty")
  .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value), {
    message: "audio chunk is not valid base64",
  })
  .refine((value) => (value.length * 3) / 4 <= MAX_CHUNK_BYTES, {
    message: `audio chunk exceeds ${MAX_CHUNK_BYTES} bytes`,
  });

export const startRecordingSchema = z.object({
  type: z.literal("start_recording"),
  // Trimmed and bounded: this goes straight into the database and the UI.
  title: z.string().trim().min(1).max(200).default("Untitled meeting"),
});

export const audioChunkSchema = z.object({
  type: z.literal("audio_chunk"),
  meetingId,
  data: base64Audio,
  sequence: z.number().int().min(0),
  mimeType: z.string().max(100).optional(),
  /**
   * Milliseconds from the start of the meeting to the start of this chunk.
   * Lets per-chunk segment timings be mapped onto absolute meeting time, which
   * turn detection needs to spot a pause that spans a chunk boundary.
   */
  startOffsetMs: z.number().int().min(0).optional(),
  /** Overlap with the previous chunk, so duplicated words can be trimmed. */
  overlapMs: z.number().int().min(0).max(10_000).optional(),
});

export const stopRecordingSchema = z.object({
  type: z.literal("stop_recording"),
  meetingId,
});

/**
 * Reconnection. The client reports the last sequence it received so the server
 * can replay only what was missed instead of the whole transcript.
 */
export const resumeRecordingSchema = z.object({
  type: z.literal("resume_recording"),
  meetingId,
  lastSequence: z.number().int().min(-1).default(-1),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  startRecordingSchema,
  audioChunkSchema,
  stopRecordingSchema,
  resumeRecordingSchema,
]);

/** @typedef {z.infer<typeof clientMessageSchema>} ClientMessage */

/**
 * Parses raw socket data into a validated message.
 *
 * Returns a result object rather than throwing, because a bad message is an
 * expected condition on a public endpoint, not an exceptional one.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, message: ClientMessage } | { ok: false, error: string }}
 */
export function parseClientMessage(raw) {
  let text;

  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    if (raw.byteLength > MAX_SOCKET_PAYLOAD_BYTES) {
      return { ok: false, error: "Message too large" };
    }
    text = raw.toString("utf8");
  } else {
    return { ok: false, error: "Unsupported message format" };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Message is not valid JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Message must be a JSON object" };
  }

  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    // "unknown message type" reads better than zod's union wording.
    const detail =
      issue.code === "invalid_union_discriminator"
        ? `unknown message type "${String(parsed.type ?? "")}"`
        : `${path ? `${path}: ` : ""}${issue.message}`;
    return { ok: false, error: detail };
  }

  return { ok: true, message: result.data };
}

// --- Server -> client messages ----------------------------------------------
// Builders rather than raw literals, so the wire format is defined in one place.

export const outbound = {
  /** @param {string} meetingId */
  recordingStarted: (meetingId) => ({ type: "recording_started", meetingId }),

  /** @param {{ speakerLabel: string, text: string, timestamp: string, sequence: number }} line */
  transcriptLine: (line) => ({
    type: "transcript_line",
    speakerLabel: line.speakerLabel,
    text: line.text,
    timestamp: line.timestamp,
    sequence: line.sequence,
  }),

  /** @param {string} message @param {{ sequence?: number, retryable?: boolean }} [meta] */
  transcriptionError: (message, meta = {}) => ({
    type: "transcription_error",
    message,
    ...meta,
  }),

  /**
   * Recording has ended and all in-flight chunks are stored. Distinct from
   * "processing": it confirms no more audio is expected, before summarization
   * has necessarily begun.
   * @param {string} meetingId
   */
  recordingStopped: (meetingId) => ({ type: "recording_stopped", meetingId }),

  processing: () => ({ type: "processing" }),

  /** @param {string} meetingId */
  momReady: (meetingId) => ({ type: "mom_ready", meetingId }),

  /** @param {string} meetingId @param {string} message */
  momFailed: (meetingId, message) => ({ type: "mom_failed", meetingId, message }),

  /** @param {string} meetingId @param {object[]} lines */
  resumed: (meetingId, lines) => ({ type: "resumed", meetingId, lines }),

  /** @param {string} message */
  error: (message) => ({ type: "error", message }),
};
