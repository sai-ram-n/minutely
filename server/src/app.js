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

/**
 * Origins allowed to call this API. Locked to the deployed frontend — never "*",
 * because a public origin plus a free API key is a fast way to lose the day's quota.
 * @returns {Set<string>}
 */
export function allowedOrigins() {
  const origins = new Set([env.FRONTEND_ORIGIN]);
  if (env.NODE_ENV !== "production") {
    // Vite's dev server, on both hostnames it answers to.
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }
  return origins;
}

export function createApp() {
  const app = express();
  const allowed = allowedOrigins();

  // Render terminates TLS upstream; without this, rate limiting sees one IP for
  // everyone and req.secure is always false.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: curl, server-to-server, and the host's own health
        // probe. Not a browser request, so CORS does not apply.
        if (!origin) return callback(null, true);
        if (allowed.has(origin)) return callback(null, true);
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
