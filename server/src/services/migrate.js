/**
 * Schema migration.
 *
 * Idempotent and safe to run on every boot: each migration is recorded in
 * schema_migrations and skipped if already applied. Same SQL works against a
 * local SQLite file and hosted Turso.
 *
 * Run standalone with:  npm run migrate --workspace server
 */

import { getClient, describeTarget } from "./db.js";

/** @typedef {{ id: string, sql: string }} Migration */

/** @type {Migration[]} */
const MIGRATIONS = [
  {
    id: "001_initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS meetings (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        ended_at    TEXT,
        status      TEXT NOT NULL DEFAULT 'recording'
                    CHECK (status IN ('recording', 'processing', 'done', 'failed'))
      );

      CREATE TABLE IF NOT EXISTS transcript_lines (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        speaker_label TEXT NOT NULL,
        text          TEXT NOT NULL,
        timestamp     TEXT NOT NULL,
        sequence      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS minutes (
        meeting_id     TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        decisions      TEXT NOT NULL,
        action_items   TEXT NOT NULL,
        open_questions TEXT NOT NULL,
        generated_at   TEXT NOT NULL
      );

      -- Transcript is always read in order for one meeting.
      CREATE INDEX IF NOT EXISTS idx_transcript_lines_meeting_sequence
        ON transcript_lines (meeting_id, sequence);

      -- History screen lists meetings newest first.
      CREATE INDEX IF NOT EXISTS idx_meetings_started_at
        ON meetings (started_at DESC);
    `,
  },
  {
    id: "002_meeting_speaker_count",
    sql: `
      -- How many people are in the meeting, captured up front.
      --
      -- Silence-gap detection can tell that the speaker CHANGED but never who
      -- is talking, so it cycles through a fixed set of labels. With the count
      -- pinned to two, a four-person meeting gave two different people the same
      -- label — worse than unhelpful, actively misleading. Asking up front is
      -- the cheapest way to make the labels mean something.
      ALTER TABLE meetings ADD COLUMN speaker_count INTEGER NOT NULL DEFAULT 2;
    `,
  },
];

async function ensureMigrationsTable(client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Applies any migrations not yet recorded.
 * @param {{ logger?: { info: (msg: string) => void } }} [options]
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function migrate(options = {}) {
  const log = options.logger ?? { info: (msg) => console.log(msg) };
  const client = getClient();

  // SQLite does not enforce foreign keys unless asked, per connection.
  await client.execute("PRAGMA foreign_keys = ON");
  await ensureMigrationsTable(client);

  const existing = await client.execute("SELECT id FROM schema_migrations");
  const done = new Set(existing.rows.map((row) => String(row.id)));

  const applied = [];
  const skipped = [];

  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    await client.executeMultiple(migration.sql);
    await client.execute({
      sql: "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      args: [migration.id, new Date().toISOString()],
    });
    applied.push(migration.id);
    log.info(`migration applied: ${migration.id}`);
  }

  return { applied, skipped };
}

// Standalone entry point: `node src/services/migrate.js`
const isDirectRun =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const { closeClient } = await import("./db.js");
  try {
    console.log(`  migrating ${describeTarget()}`);
    const { applied, skipped } = await migrate();
    console.log(
      `  done — ${applied.length} applied, ${skipped.length} already present`,
    );
    closeClient();
  } catch (err) {
    console.error(`  migration failed: ${err.message}`);
    closeClient();
    process.exit(1);
  }
}
