/**
 * Express app construction.
 *
 * Kept separate from index.js so tests can build an app without binding a port
 * or starting the WebSocket server.
 */

import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { createSystemRouter } from "./routes/system.js";
import { createMeetingsRouter } from "./routes/meetings.js";

/**
 * Whether an origin may call this API.
 *
 * Production is strict: an exact match against FRONTEND_ORIGIN and nothing
 * else — never "*", because a public origin plus a free API key is a fast way
 * to lose the day's quota.
 *
 * Development also accepts any localhost port. Vite silently picks a different
 * port when its default is taken, and pinning the allowlist to one port turns
 * that into a WebSocket handshake 403 with no obvious cause.
 *
 * @param {string | undefined} origin
 * @returns {boolean}
 */
export function isOriginAllowed(origin) {
  // No Origin header: curl, server-to-server, and the host's own health probe.
  // Not a browser request, so CORS does not apply.
  if (!origin) return true;
  if (origin === env.FRONTEND_ORIGIN) return true;

  if (env.NODE_ENV !== "production") return isLocalDevOrigin(origin);

  return false;
}

/**
 * Whether an origin is a local development address.
 *
 * Covers localhost and private (RFC1918) LAN addresses, so the dev server can
 * be reached from a phone or another machine on the same network without
 * every request failing CORS. Deliberately excludes anything routable from the
 * public internet, and is never consulted in production.
 *
 * @param {string} origin
 * @returns {boolean}
 */
export function isLocalDevOrigin(origin) {
  let host;
  try {
    ({ hostname: host } = new URL(origin));
  } catch {
    return false;
  }

  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return true;
  }

  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // 172.16.0.0/12 — note 172.16 through 172.31 only, not 172.32+
  const match = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }

  return false;
}

/**
 * Human-readable description of what is allowed, for boot logs and errors.
 * @returns {string}
 */
export function describeAllowedOrigins() {
  return env.NODE_ENV === "production"
    ? env.FRONTEND_ORIGIN
    : `${env.FRONTEND_ORIGIN} plus any localhost port (development only)`;
}

/**
 * @param {Object} [options]
 * @param {import("./ai/provider.js").AiProvider} [options.provider]
 *   Injected by tests so routes can be exercised without the real API.
 */
export function createApp(options = {}) {
  const app = express();

  // Render terminates TLS upstream; without this, rate limiting sees one IP for
  // everyone and req.secure is always false.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());

  app.use(
    cors({
      origin(origin, callback) {
        if (isOriginAllowed(origin)) return callback(null, true);
        logger.warn({ origin }, "CORS rejected a disallowed origin");
        return callback(new Error("Not allowed by CORS"));
      },
      credentials: false,
    }),
  );

  // Audio arrives over the WebSocket, not REST, so a small JSON cap is correct
  // here and stops oversized bodies from becoming a memory problem.
  app.use(express.json({ limit: "256kb" }));

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 100,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // /api/health is deliberately exempt: it is the documented way to wake the
    // host before a demo and is polled by CI.
    skip: (req) => req.path === "/health",
    message: { error: "Too many requests — slow down and try again shortly." },
  });

  app.use("/api", apiLimiter, createSystemRouter());
  app.use("/api/meetings", apiLimiter, createMeetingsRouter({ provider: options.provider }));

  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
  });

  // Final error handler. Four args is required for Express to treat it as one,
  // even though the last is unused.
  app.use((err, req, res, _next) => {
    const isCors = err?.message === "Not allowed by CORS";
    const status = isCors ? 403 : 500;

    logger.error(
      { err: err?.message, path: req.originalUrl, method: req.method },
      "request failed",
    );

    // Never leak internals to the client; the detail is in the server log.
    res.status(status).json({
      error: isCors ? "Origin not allowed" : "Internal server error",
    });
  });

  return app;
}
