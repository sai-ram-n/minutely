/**
 * Meeting WebSocket.
 *
 * Carries live audio up and transcript lines back down. Everything inbound is
 * schema-validated before it is touched, and every handler is wrapped so that a
 * malformed payload or a provider failure becomes a message to the client
 * rather than a dead server.
 *
 * Phase 3 scope: start / chunk / stop / resume. Summarization on stop arrives in
 * Phase 5 — see finalizeMeeting().
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { logger } from "../config/logger.js";
import { allowedOrigins } from "../app.js";
import { getProvider } from "../ai/index.js";
import {
  parseClientMessage,
  outbound,
  MAX_SOCKET_PAYLOAD_BYTES,
} from "./messages.js";
import {
  transcribeChunk,
  enqueue,
  clearQueue,
} from "../services/transcription.js";
import {
  createMeeting,
  getMeeting,
  updateMeetingStatus,
  getTranscriptLinesSince,
} from "../services/db.js";

/** How often to ping clients to detect connections that died without closing. */
const HEARTBEAT_MS = 30_000;

/** Upgrade attempts allowed per IP per minute — protects the Groq quota. */
const UPGRADE_LIMIT = 30;
const UPGRADE_WINDOW_MS = 60_000;

/**
 * express-rate-limit does not see the HTTP upgrade, so connection rate limiting
 * is done here. In-memory is the right scope: this is per-instance abuse
 * protection, not distributed accounting.
 */
function createUpgradeLimiter() {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  return {
    /** @param {string} ip @returns {boolean} true if allowed */
    allow(ip) {
      const now = Date.now();
      const recent = (hits.get(ip) ?? []).filter((t) => now - t < UPGRADE_WINDOW_MS);
      recent.push(now);
      hits.set(ip, recent);
      return recent.length <= UPGRADE_LIMIT;
    },
    /** Drops stale entries so the map cannot grow without bound. */
    sweep() {
      const now = Date.now();
      for (const [ip, times] of hits) {
        const recent = times.filter((t) => now - t < UPGRADE_WINDOW_MS);
        if (recent.length === 0) hits.delete(ip);
        else hits.set(ip, recent);
      }
    },
  };
}

/**
 * @param {import("ws").WebSocket} socket
 * @param {object} payload
 */
function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

/**
 * Attaches the meeting WebSocket to an existing HTTP server.
 *
 * @param {import("node:http").Server} server
 * @param {Object} [options]
 * @param {import("../ai/provider.js").AiProvider} [options.provider] Injected by tests.
 * @param {(meetingId: string) => Promise<void>} [options.onFinalize]
 *   Summarization hook, wired in Phase 5. Absent means recording simply ends.
 * @returns {import("ws").WebSocketServer}
 */
export function attachMeetingSocket(server, options = {}) {
  const provider = options.provider ?? getProvider();
  const allowed = allowedOrigins();
  const limiter = createUpgradeLimiter();

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: MAX_SOCKET_PAYLOAD_BYTES,
    // Audio chunks are already compressed; per-message deflate would burn CPU
    // on a small free instance for no gain.
    perMessageDeflate: false,
    verifyClient({ origin, req }, callback) {
      const ip = req.socket.remoteAddress ?? "unknown";

      if (!limiter.allow(ip)) {
        logger.warn({ ip }, "WebSocket upgrade rate limited");
        return callback(false, 429, "Too many connection attempts");
      }

      // A browser always sends Origin. Its absence means a non-browser client,
      // which is allowed for local tooling but never carries ambient credentials.
      if (origin && !allowed.has(origin)) {
        logger.warn({ origin, ip }, "WebSocket upgrade rejected — disallowed origin");
        return callback(false, 403, "Origin not allowed");
      }

      return callback(true);
    },
  });

  const sweeper = setInterval(() => limiter.sweep(), UPGRADE_WINDOW_MS);
  sweeper.unref?.();

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
  });

  wss.on("connection", (socket, req) => {
    const connectionId = randomUUID();
    const log = logger.child({ connectionId });

    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    log.info({ ip: req.socket.remoteAddress }, "WebSocket connected");

    socket.on("message", (raw) => {
      // Never let a handler rejection become an unhandled rejection.
      handleMessage({ socket, raw, provider, log, options }).catch((err) => {
        log.error({ err: err.message }, "unhandled error in socket message handler");
        send(socket, outbound.error("Something went wrong handling that message."));
      });
    });

    socket.on("error", (err) => {
      log.warn({ err: err.message }, "WebSocket error");
    });

    socket.on("close", (code) => {
      log.info({ code }, "WebSocket closed");
    });
  });

  logger.info({ path: "/ws" }, "meeting WebSocket attached");
  return wss;
}

/**
 * Routes one validated message.
 * @param {{ socket: import("ws").WebSocket, raw: unknown, provider: import("../ai/provider.js").AiProvider, log: import("pino").Logger, options: object }} context
 */
async function handleMessage({ socket, raw, provider, log, options }) {
  const parsed = parseClientMessage(raw);

  if (!parsed.ok) {
    // Rejected, logged, connection left open — a bad frame is not fatal.
    log.warn({ reason: parsed.error }, "rejected malformed WebSocket message");
    send(socket, outbound.error(parsed.error));
    return;
  }

  const message = parsed.message;

  switch (message.type) {
    case "start_recording":
      return handleStart({ socket, message, log });
    case "audio_chunk":
      return handleAudioChunk({ socket, message, provider, log });
    case "stop_recording":
      return handleStop({ socket, message, log, options });
    case "resume_recording":
      return handleResume({ socket, message, log });
    default:
      send(socket, outbound.error("Unsupported message type"));
  }
}

async function handleStart({ socket, message, log }) {
  const meetingId = randomUUID();
  await createMeeting({ id: meetingId, title: message.title });

  log.info({ meetingId, title: message.title }, "recording started");
  send(socket, outbound.recordingStarted(meetingId));
}

async function handleAudioChunk({ socket, message, provider, log }) {
  const meeting = await getMeeting(message.meetingId);

  if (!meeting) {
    send(socket, outbound.error("Unknown meeting — start a recording first."));
    return;
  }
  if (meeting.status !== "recording") {
    send(
      socket,
      outbound.error(`Meeting is ${meeting.status}, not accepting more audio.`),
    );
    return;
  }

  const audio = Buffer.from(message.data, "base64");

  // Queued per meeting so chunks are applied in order even if their
  // transcription requests finish out of order.
  await enqueue(message.meetingId, async () => {
    try {
      const line = await transcribeChunk({
        provider,
        meetingId: message.meetingId,
        audio,
        sequence: message.sequence,
        mimeType: message.mimeType,
        startOffsetMs: message.startOffsetMs,
      });

      if (line) {
        send(
          socket,
          outbound.transcriptLine({
            speakerLabel: line.speaker_label,
            text: line.text,
            timestamp: line.timestamp,
            sequence: line.sequence,
          }),
        );
      }
    } catch (err) {
      // Tell the user. Never silently drop a chunk.
      const isRateLimit = err?.status === 429;
      log.warn(
        { err: err.message, sequence: message.sequence, status: err?.status },
        "chunk transcription failed",
      );

      send(
        socket,
        outbound.transcriptionError(
          isRateLimit
            ? "Transcription is rate limited right now — some audio may be missing."
            : "Could not transcribe that section of audio.",
          { sequence: message.sequence, retryable: isRateLimit },
        ),
      );
    }
  });
}

async function handleStop({ socket, message, log, options }) {
  const meeting = await getMeeting(message.meetingId);

  if (!meeting) {
    send(socket, outbound.error("Unknown meeting."));
    return;
  }

  // Let any in-flight chunks finish before ending, so the tail of the meeting
  // is not lost.
  await enqueue(message.meetingId, async () => {});
  clearQueue(message.meetingId);

  const endedAt = new Date().toISOString();
  await updateMeetingStatus(message.meetingId, "processing", { endedAt });
  send(socket, outbound.recordingStopped(message.meetingId));

  if (!options.onFinalize) {
    // Phase 5 wires summarization here. Until then a meeting must not be left
    // sitting in "processing" forever, so it is closed out immediately.
    await updateMeetingStatus(message.meetingId, "done");
    log.info({ meetingId: message.meetingId }, "recording stopped (summarization not yet wired)");
    return;
  }

  send(socket, outbound.processing());
  try {
    await options.onFinalize(message.meetingId);
    send(socket, outbound.momReady(message.meetingId));
  } catch (err) {
    log.error({ err: err.message, meetingId: message.meetingId }, "summarization failed");
    await updateMeetingStatus(message.meetingId, "failed");
    send(
      socket,
      outbound.momFailed(
        message.meetingId,
        "Could not generate minutes. You can retry from the meeting page.",
      ),
    );
  }
}

/**
 * Reconnection: replay only the lines the client missed.
 *
 * A dropped socket on a free host is a real risk, and losing the rest of a
 * meeting to it is not acceptable.
 */
async function handleResume({ socket, message, log }) {
  const meeting = await getMeeting(message.meetingId);

  if (!meeting) {
    send(socket, outbound.error("Unknown meeting — cannot resume."));
    return;
  }

  const missed = await getTranscriptLinesSince(message.meetingId, message.lastSequence);

  log.info(
    { meetingId: message.meetingId, from: message.lastSequence, replayed: missed.length },
    "client resumed",
  );

  send(
    socket,
    outbound.resumed(
      message.meetingId,
      missed.map((line) => ({
        speakerLabel: line.speaker_label,
        text: line.text,
        timestamp: line.timestamp,
        sequence: line.sequence,
      })),
    ),
  );
}
