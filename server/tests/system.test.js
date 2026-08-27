/**
 * System route behaviour, exercised through the real Express app.
 *
 * Uses createApp() rather than booting index.js, so no port is bound and no
 * WebSocket server starts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { migrate } from "../src/services/migrate.js";
import { closeClient } from "../src/services/db.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const versionJson = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "version.json"), "utf8"),
);

let app;

beforeAll(async () => {
  await migrate({ logger: { info: () => {} } });
  app = createApp();
});

afterAll(() => {
  closeClient();
});

describe("GET /api/health", () => {
  it("reports ok and proves the database is actually reachable", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    // "ok" here means a real SELECT round-tripped, not merely that the
    // process is running.
    expect(res.body.database).toBe("ok");
    expect(res.body.version).toBe(versionJson.version);
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("is exempt from rate limiting, so it can still wake a sleeping host", async () => {
    // Well past the 100/min limit that applies to other /api routes.
    for (let i = 0; i < 120; i += 1) {
      await request(app).get("/api/health");
    }
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/version", () => {
  it("serves version.json verbatim — the single source of truth", async () => {
    const res = await request(app).get("/api/version");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: versionJson.name,
      version: versionJson.version,
      releaseDate: versionJson.releaseDate,
    });
  });
});

describe("CORS lock-down", () => {
  it("allows the configured frontend origin", async () => {
    const res = await request(app)
      .get("/api/version")
      .set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("rejects an unknown origin instead of falling back to *", async () => {
    const res = await request(app)
      .get("/api/version")
      .set("Origin", "https://evil.example");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Origin not allowed");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows requests with no Origin header (curl, host health probes)", async () => {
    const res = await request(app).get("/api/version");
    expect(res.status).toBe(200);
  });
});

describe("error handling", () => {
  it("returns a structured 404 rather than Express's HTML default", async () => {
    const res = await request(app).get("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Not found");
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("does not advertise the server framework", async () => {
    const res = await request(app).get("/api/version");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("sets helmet's security headers", async () => {
    const res = await request(app).get("/api/version");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });
});
