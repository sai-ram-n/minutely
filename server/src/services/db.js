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
import { logger } from "../config/logger.js";
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

/**
 * Next line sequence for a meeting.
 *
 * A single audio chunk can contain several speaker turns, so line sequence is
 * not the same as chunk sequence. Derived from the database rather than held in
 * memory, so it stays correct across a restart.
 *
 * @param {string} meetingId
 * @returns {Promise<number>}
 */
export async function getNextLineSequence(meetingId) {
  const result = await getClient().execute({
    sql: `SELECT COALESCE(MAX(sequence), -1) + 1 AS next
          FROM transcript_lines WHERE meeting_id = ?`,
    args: [meetingId],
  });
  return Number(result.rows[0]?.next ?? 0);
}

/**
 * Renames a speaker across a meeting's transcript.
 *
 * Stored as a plain relabel of the affected rows: the schema has one label per
 * line and no separate override table, so this keeps the data model as
 * specified rather than adding a table for a single field.
 *
 * @param {string} meetingId
 * @param {string} from Existing label, e.g. "Speaker 2"
 * @param {string} to   New label
 * @returns {Promise<number>} Rows updated
 */
export async function renameSpeaker(meetingId, from, to) {
  const result = await getClient().execute({
    sql: `UPDATE transcript_lines SET speaker_label = ?
          WHERE meeting_id = ? AND speaker_label = ?`,
    args: [to, meetingId, from],
  });
  return Number(result.rowsAffected ?? 0);
}

/**
 * Distinct speaker labels in a meeting, in the order they first speak.
 * @param {string} meetingId
 * @returns {Promise<string[]>}
 */
export async function listSpeakers(meetingId) {
  const result = await getClient().execute({
    sql: `SELECT speaker_label, MIN(sequence) AS first_seen
          FROM transcript_lines WHERE meeting_id = ?
          GROUP BY speaker_label ORDER BY first_seen ASC`,
    args: [meetingId],
  });
  return result.rows.map((row) => String(row.speaker_label));
}

// ---------------------------------------------------------------------------
// Minutes
//
// The three columns are TEXT, so structured values are stored as JSON and
// validated on the way back out. Data that has been through a database and an
// LLM is not trusted on read any more than on write.
// ---------------------------------------------------------------------------

/**
 * Inserts or replaces a meeting's minutes.
 *
 * @param {string} meetingId
 * @param {import("../ai/provider.js").MinutesResult} minutes
 * @param {{ generatedAt?: string }} [options]
 */
export async function upsertMinutes(meetingId, minutes, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  await getClient().execute({
    sql: `INSERT INTO minutes (meeting_id, decisions, action_items, open_questions, generated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(meeting_id) DO UPDATE SET
            decisions      = excluded.decisions,
            action_items   = excluded.action_items,
            open_questions = excluded.open_questions,
            generated_at   = excluded.generated_at`,
    args: [
      meetingId,
      JSON.stringify(minutes.decisions),
      JSON.stringify(minutes.action_items),
      JSON.stringify(minutes.open_questions),
      generatedAt,
    ],
  });

  return { ...minutes, generated_at: generatedAt };
}

/**
 * Parses a JSON column, falling back to an empty array rather than throwing.
 * A single corrupt row should degrade one section of the UI, not break the page.
 * @param {unknown} value
 * @param {string} label
 */
function parseJsonColumn(value, label) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    logger.warn({ column: label }, "minutes column was not valid JSON — treating as empty");
    return [];
  }
}

/**
 * @param {string} meetingId
 * @returns {Promise<(import("../ai/provider.js").MinutesResult & { generated_at: string }) | null>}
 */
export async function getMinutes(meetingId) {
  const result = await getClient().execute({
    sql: "SELECT * FROM minutes WHERE meeting_id = ?",
    args: [meetingId],
  });

  const row = result.rows[0];
  if (!row) return null;

  return {
    decisions: parseJsonColumn(row.decisions, "decisions"),
    action_items: parseJsonColumn(row.action_items, "action_items"),
    open_questions: parseJsonColumn(row.open_questions, "open_questions"),
    generated_at: String(row.generated_at),
  };
}
