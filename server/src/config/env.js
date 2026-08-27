/**
 * Environment validation.
 *
 * Every env var the server depends on is declared and validated here, once, at
 * boot. If anything required is missing or malformed the process exits with a
 * readable message instead of starting into a broken state and failing
 * confusingly on the first request.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** server/ package root — resolved from this module, so cwd does not matter. */
export const SERVER_ROOT = resolve(__dirname, "..", "..");
/** repo root — where version.json lives. */
export const REPO_ROOT = resolve(SERVER_ROOT, "..");

// Load server/.env if present. Real deploys (Render) inject env vars directly
// and will not have a .env file; that is expected, not an error.
//
// Deliberately skipped under NODE_ENV=test: tests must declare their own
// environment explicitly, or a developer's local .env would leak in and mask
// exactly the misconfiguration a test is trying to prove is caught.
const envFile = resolve(SERVER_ROOT, ".env");
if (process.env.NODE_ENV !== "test" && existsSync(envFile)) {
  dotenv.config({ path: envFile });
}

const DEFAULT_LOCAL_DB = "file:./local.db";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),

    PORT: z.coerce
      .number()
      .int("PORT must be a whole number")
      .min(1)
      .max(65535)
      .default(3001),

    // The one credential that must always be present. Trimmed so a stray
    // newline pasted from a key file does not become a silently broken header.
    GROQ_API_KEY: z
      .string({ required_error: "GROQ_API_KEY is required" })
      .trim()
      .min(1, "GROQ_API_KEY must not be empty"),

    // Unset locally -> local SQLite file. Set in production -> hosted Turso.
    TURSO_DATABASE_URL: z
      .string()
      .trim()
      .min(1)
      .default(DEFAULT_LOCAL_DB),

    TURSO_AUTH_TOKEN: z.string().trim().min(1).optional(),

    // Used to lock CORS down to the deployed frontend. Never "*".
    FRONTEND_ORIGIN: z
      .string()
      .trim()
      .min(1)
      .default("http://localhost:5173"),

    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    // --- AI provider -------------------------------------------------------
    // Model IDs are configuration, not code. Providers retire models (Groq
    // retired llama-3.3-70b-versatile, which this project originally named), so
    // swapping one must never require a code change or a redeploy of anything
    // but an env var.

    GROQ_BASE_URL: z
      .string()
      .trim()
      .url("GROQ_BASE_URL must be a valid URL")
      .default("https://api.groq.com/openai/v1"),

    GROQ_TRANSCRIBE_MODEL: z
      .string()
      .trim()
      .min(1)
      .default("whisper-large-v3-turbo"),

    GROQ_SUMMARY_MODEL: z
      .string()
      .trim()
      .min(1)
      .default("openai/gpt-oss-120b"),

    // Request timeout for a single AI call, before retry logic gets involved.
    AI_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(300000)
      .default(120000),
  })
  .superRefine((env, ctx) => {
    // A remote libsql:// database is unreachable without a token. Catching this
    // at boot beats a confusing auth error on the first query in production.
    const isRemote = /^libsql:\/\//.test(env.TURSO_DATABASE_URL);
    if (isRemote && !env.TURSO_AUTH_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURSO_AUTH_TOKEN"],
        message:
          "TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a remote libsql:// database",
      });
    }

    if (env.NODE_ENV === "production") {
      if (env.TURSO_DATABASE_URL.startsWith("file:")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TURSO_DATABASE_URL"],
          message:
            "must be a remote libsql:// URL in production — the host filesystem is ephemeral, so a local SQLite file would be silently wiped on every restart",
        });
      }
      if (/localhost|127\.0\.0\.1/.test(env.FRONTEND_ORIGIN)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["FRONTEND_ORIGIN"],
          message:
            "must be the real deployed frontend origin in production, not localhost — CORS would reject your own site",
        });
      }
    }
  });

/** @typedef {z.infer<typeof envSchema>} Env */

function formatAndExit(error) {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    return `  - ${key}: ${issue.message}`;
  });

  process.stderr.write(
    [
      "",
      "  Minutely server cannot start — invalid environment configuration:",
      "",
      ...lines,
      "",
      `  Copy .env.example to server/.env and fill in the missing values.`,
      "",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * Parses and validates process.env. Exits the process on failure.
 * @returns {Env}
 */
export function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) formatAndExit(result.error);
  return result.data;
}

export const env = loadEnv();

/** True when the database is a local file rather than hosted Turso. */
export const isLocalDatabase = env.TURSO_DATABASE_URL.startsWith("file:");

/**
 * The repo-root version.json, read directly from disk — no build step, and it
 * stays the single source of truth for name/version/releaseDate.
 * @returns {{ name: string, version: string, releaseDate: string }}
 */
export function readVersion() {
  const path = resolve(REPO_ROOT, "version.json");
  return JSON.parse(readFileSync(path, "utf8"));
}
