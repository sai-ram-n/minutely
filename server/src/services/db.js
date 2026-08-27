/**
 * Database access.
 *
 * One @libsql/client talks to BOTH targets with identical SQL:
 *   - dev:        file:./local.db      (no cloud setup needed)
 *   - production: libsql://...turso.io (survives the host's ephemeral filesystem)
 *
 * Because Turso is SQLite-compatible, nothing below changes between the two.
 */

import { createClient } from "@libsql/client";
import { resolve } from "node:path";
import { env, SERVER_ROOT, isLocalDatabase } from "../config/env.js";

/**
 * A relative `file:./local.db` URL would resolve against the process cwd, which
 * differs depending on whether you run from the repo root or server/. Pin it to
 * the server package root so the same database file is used either way.
 */
function resolveDatabaseUrl() {
  if (!isLocalDatabase) return env.TURSO_DATABASE_URL;

  const path = env.TURSO_DATABASE_URL.slice("file:".length);

  // ":memory:" is a SQLite sentinel, not a path. Resolving it against a
  // directory would silently create a real file literally named ":memory:".
  if (path === ":memory:" || path.startsWith(":memory:")) {
    return env.TURSO_DATABASE_URL;
  }

  return `file:${resolve(SERVER_ROOT, path)}`;
}

/** @type {import("@libsql/client").Client | null} */
let client = null;

/** @returns {import("@libsql/client").Client} */
export function getClient() {
  if (!client) {
    client = createClient({
      url: resolveDatabaseUrl(),
      ...(env.TURSO_AUTH_TOKEN ? { authToken: env.TURSO_AUTH_TOKEN } : {}),
    });
  }
  return client;
}

/**
 * Cheap round-trip used by /api/health to prove the database is actually
 * reachable, rather than reporting "ok" purely because the process is up.
 * @returns {Promise<boolean>}
 */
export async function ping() {
  const result = await getClient().execute("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}

/** Closes the connection. Used by tests and graceful shutdown. */
export function closeClient() {
  if (client) {
    client.close();
    client = null;
  }
}

/** Human-readable description of the active target, for boot logs. */
export function describeTarget() {
  if (!isLocalDatabase) return `remote Turso (${env.TURSO_DATABASE_URL})`;
  const path = resolveDatabaseUrl().replace("file:", "");
  return path.startsWith(":memory:")
    ? "in-memory database"
    : `local file (${path})`;
}

// ---------------------------------------------------------------------------
// Queries
//
// Kept as plain functions returning plain objects. Every one uses bound
// parameters — no string interpolation into SQL, anywhere.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MeetingRow
 * @property {string} id
 * @property {string} title
 * @property {string} started_at
 * @property {string | null} ended_at
 * @property {"recording" | "processing" | "done" | "failed"} status
 */

/**
 * @typedef {Object} TranscriptLineRow
 * @property {number} id
 * @property {string} meeting_id
 * @property {string} speaker_label
 * @property {string} text
 * @property {string} timestamp
 * @property {number} sequence
 */

/**
 * @param {{ id: string, title: string, startedAt?: string }} meeting
 * @returns {Promise<MeetingRow>}
 */
export async function createMeeting({ id, title, startedAt }) {
  const started = startedAt ?? new Date().toISOString();
  await getClient().execute({
    sql: `INSERT INTO meetings (id, title, started_at, status)
          VALUES (?, ?, ?, 'recording')`,
    args: [id, title, started],
  });
  return { id, title, started_at: started, ended_at: null, status: "recording" };
}

/**
 * @param {string} id
 * @returns {Promise<MeetingRow | null>}
 */
export async function getMeeting(id) {
  const result = await getClient().execute({
    sql: "SELECT * FROM meetings WHERE id = ?",
    args: [id],
  });
  return /** @type {MeetingRow | null} */ (result.rows[0] ?? null);
}

/**
 * Newest first, for the history screen.
 * @returns {Promise<MeetingRow[]>}
 */
export async function listMeetings() {
  const result = await getClient().execute(
    "SELECT * FROM meetings ORDER BY started_at DESC",
  );
  return /** @type {MeetingRow[]} */ (result.rows);
}

/**
 * @param {string} id
 * @param {"recording" | "processing" | "done" | "failed"} status
 * @param {{ endedAt?: string }} [options]
 */
export async function updateMeetingStatus(id, status, options = {}) {
  if (options.endedAt) {
    await getClient().execute({
      sql: "UPDATE meetings SET status = ?, ended_at = ? WHERE id = ?",
      args: [status, options.endedAt, id],
    });
    return;
  }
  await getClient().execute({
    sql: "UPDATE meetings SET status = ? WHERE id = ?",
    args: [status, id],
  });
}

/**
 * @param {{ meetingId: string, speakerLabel: string, text: string, timestamp?: string, sequence: number }} line
 * @returns {Promise<TranscriptLineRow>}
 */
export async function insertTranscriptLine({
  meetingId,
  speakerLabel,
  text,
  timestamp,
  sequence,
}) {
  const at = timestamp ?? new Date().toISOString();
  const result = await getClient().execute({
    sql: `INSERT INTO transcript_lines (meeting_id, speaker_label, text, timestamp, sequence)
          VALUES (?, ?, ?, ?, ?)
          RETURNING id`,
    args: [meetingId, speakerLabel, text, at, sequence],
  });

  return {
    id: Number(result.rows[0]?.id),
    meeting_id: meetingId,
    speaker_label: speakerLabel,
    text,
    timestamp: at,
    sequence,
  };
}

/**
 * @param {string} meetingId
 * @returns {Promise<TranscriptLineRow[]>}
 */
export async function getTranscriptLines(meetingId) {
  const result = await getClient().execute({
    sql: `SELECT * FROM transcript_lines
          WHERE meeting_id = ?
          ORDER BY sequence ASC, id ASC`,
    args: [meetingId],
  });
  return /** @type {TranscriptLineRow[]} */ (result.rows);
}

/**
 * Lines after a given sequence — used when a client reconnects mid-meeting and
 * needs only what it missed, rather than the whole transcript again.
 * @param {string} meetingId
 * @param {number} afterSequence
 * @returns {Promise<TranscriptLineRow[]>}
 */
export async function getTranscriptLinesSince(meetingId, afterSequence) {
  const result = await getClient().execute({
    sql: `SELECT * FROM transcript_lines
          WHERE meeting_id = ? AND sequence > ?
          ORDER BY sequence ASC, id ASC`,
    args: [meetingId, afterSequence],
  });
  return /** @type {TranscriptLineRow[]} */ (result.rows);
}

/**
 * The most recent line, used to dedupe the overlap between adjacent audio chunks.
 * @param {string} meetingId
 * @returns {Promise<TranscriptLineRow | null>}
 */
export async function getLastTranscriptLine(meetingId) {
  const result = await getClient().execute({
    sql: `SELECT * FROM transcript_lines
          WHERE meeting_id = ?
          ORDER BY sequence DESC, id DESC
          LIMIT 1`,
    args: [meetingId],
  });
  return /** @type {TranscriptLineRow | null} */ (result.rows[0] ?? null);
}

/**
 * Full transcript as text, for summarization and export.
 * @param {string} meetingId
 * @returns {Promise<string>}
 */
export async function getTranscriptText(meetingId) {
  const lines = await getTranscriptLines(meetingId);
  return lines.map((line) => `${line.speaker_label}: ${line.text}`).join("\n");
}
