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
