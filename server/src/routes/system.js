/**
 * System routes: health and version.
 *
 * GET /api/health  — also used to warm the host up before a demo, and by CI.
 * GET /api/version — read from the repo-root version.json, the single source of
 *                    truth. The client compares this against its own synced copy
 *                    and warns on mismatch, which catches "deployed the frontend
 *                    but not the backend".
 */

import { Router } from "express";
import { readVersion } from "../config/env.js";
import { ping, describeTarget } from "../services/db.js";

export function createSystemRouter() {
  const router = Router();

  // Read once at startup: version.json cannot change without a redeploy.
  const version = readVersion();
  const startedAt = Date.now();

  router.get("/health", async (_req, res) => {
    let database = "ok";
    let healthy = true;

    try {
      healthy = await ping();
      if (!healthy) database = "unexpected response";
    } catch (err) {
      healthy = false;
      database = err instanceof Error ? err.message : "unreachable";
    }

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      version: version.version,
      database,
      target: describeTarget(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/version", (_req, res) => {
    res.json(version);
  });

  return router;
}
