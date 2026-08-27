/**
 * Environment validation.
 *
 * These run the real entry point in a child process, because the behaviour under
 * test IS the process exiting. Asserting on an exported schema would not prove
 * the server actually refuses to boot.
 */

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(SERVER_ROOT, "src", "index.js");

/**
 * Boots the server with a given environment and returns how it exited.
 * @param {Record<string, string>} envOverrides
 */
async function boot(envOverrides) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // NODE_ENV=test makes env.js skip loading server/.env, so a developer's real
    // key cannot leak in and mask the misconfiguration under test. Overridable
    // by the cases that specifically exercise production behaviour.
    NODE_ENV: "test",
    ...envOverrides,
  };

  try {
    await execFileAsync(process.execPath, [ENTRY], {
      cwd: SERVER_ROOT,
      env,
      timeout: 15_000,
    });
    return { code: 0, stderr: "" };
  } catch (err) {
    return { code: err.code ?? 1, stderr: String(err.stderr ?? "") };
  }
}

describe("environment validation", () => {
  it("refuses to start when GROQ_API_KEY is missing", async () => {
    const { code, stderr } = await boot({});
    expect(code).toBe(1);
    expect(stderr).toContain("GROQ_API_KEY is required");
    expect(stderr).toContain("cannot start");
  });

  it("refuses to start when GROQ_API_KEY is empty", async () => {
    const { code, stderr } = await boot({ GROQ_API_KEY: "   " });
    expect(code).toBe(1);
    expect(stderr).toContain("GROQ_API_KEY must not be empty");
  });

  it("reports every invalid variable at once, not just the first", async () => {
    const { code, stderr } = await boot({ PORT: "banana" });
    expect(code).toBe(1);
    expect(stderr).toContain("PORT");
    expect(stderr).toContain("GROQ_API_KEY");
  });

  it("rejects a local SQLite file in production, where the disk is ephemeral", async () => {
    const { code, stderr } = await boot({
      GROQ_API_KEY: "gsk_test",
      NODE_ENV: "production",
      FRONTEND_ORIGIN: "https://minutely.pages.dev",
      TURSO_DATABASE_URL: "file:./local.db",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("TURSO_DATABASE_URL");
    expect(stderr).toContain("ephemeral");
  });

  it("rejects a localhost FRONTEND_ORIGIN in production, which would break CORS", async () => {
    const { code, stderr } = await boot({
      GROQ_API_KEY: "gsk_test",
      NODE_ENV: "production",
      TURSO_DATABASE_URL: "libsql://demo.turso.io",
      TURSO_AUTH_TOKEN: "token",
      FRONTEND_ORIGIN: "http://localhost:5173",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("FRONTEND_ORIGIN");
  });

  it("requires a Turso auth token when the database is remote", async () => {
    const { code, stderr } = await boot({
      GROQ_API_KEY: "gsk_test",
      NODE_ENV: "production",
      FRONTEND_ORIGIN: "https://minutely.pages.dev",
      TURSO_DATABASE_URL: "libsql://demo.turso.io",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("TURSO_AUTH_TOKEN");
  });
});
