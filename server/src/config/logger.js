/**
 * Structured JSON logging.
 *
 * Production emits raw JSON (what Render's log viewer and any aggregator want).
 * Development pipes through pino-pretty for readability, but only if it is
 * actually installed — it is a devDependency, so production must never require it.
 */

import pino from "pino";
import { env } from "./env.js";

/** @returns {import("pino").LoggerOptions} */
function buildOptions() {
  /** @type {import("pino").LoggerOptions} */
  const options = {
    level: env.LOG_LEVEL,
    base: { service: "minutely-server" },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Belt and braces: even if a secret is ever passed into a log call by
    // mistake, it is redacted rather than written to the log stream.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "GROQ_API_KEY",
        "TURSO_AUTH_TOKEN",
        "*.apiKey",
        "*.authToken",
      ],
      censor: "[redacted]",
    },
  };

  if (env.NODE_ENV === "development") {
    try {
      // Throws if pino-pretty is not installed (i.e. a production install).
      import.meta.resolve("pino-pretty");
      options.transport = {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" },
      };
    } catch {
      // Fall through to plain JSON logging.
    }
  }

  return options;
}

export const logger = pino(buildOptions());
