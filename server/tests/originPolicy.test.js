/**
 * Origin policy.
 *
 * Production must be strict. Development must not be so strict that Vite
 * picking a different port turns into an unexplained 403 on the WebSocket
 * handshake — which is exactly what happened when the allowlist was pinned to
 * a single port.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function loadWithEnv(overrides) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  return import("../src/app.js");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("development", () => {
  it("allows the configured frontend origin", async () => {
    const { isOriginAllowed } = await loadWithEnv({
      NODE_ENV: "development",
      FRONTEND_ORIGIN: "http://localhost:5173",
    });
    expect(isOriginAllowed("http://localhost:5173")).toBe(true);
  });

  it("allows any localhost port, so a shifted Vite port is not a silent 403", async () => {
    const { isOriginAllowed } = await loadWithEnv({
      NODE_ENV: "development",
      FRONTEND_ORIGIN: "http://localhost:5173",
    });

    expect(isOriginAllowed("http://localhost:5174")).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:5174")).toBe(true);
    expect(isOriginAllowed("http://localhost:3000")).toBe(true);
  });

  it("still rejects a remote origin in development", async () => {
    const { isOriginAllowed } = await loadWithEnv({
      NODE_ENV: "development",
      FRONTEND_ORIGIN: "http://localhost:5173",
    });

    expect(isOriginAllowed("https://evil.example")).toBe(false);
    // A hostname that merely contains "localhost" must not pass.
    expect(isOriginAllowed("https://localhost.evil.example")).toBe(false);
    expect(isOriginAllowed("http://notlocalhost")).toBe(false);
  });

  it("allows a request with no Origin header at all", async () => {
    const { isOriginAllowed } = await loadWithEnv({
      NODE_ENV: "development",
      FRONTEND_ORIGIN: "http://localhost:5173",
    });
    expect(isOriginAllowed(undefined)).toBe(true);
  });
});

describe("production", () => {
  const prodEnv = {
    NODE_ENV: "production",
    FRONTEND_ORIGIN: "https://minutely.pages.dev",
    TURSO_DATABASE_URL: "libsql://demo.turso.io",
    TURSO_AUTH_TOKEN: "token",
  };

  it("allows exactly the deployed frontend", async () => {
    const { isOriginAllowed } = await loadWithEnv(prodEnv);
    expect(isOriginAllowed("https://minutely.pages.dev")).toBe(true);
  });

  it("rejects localhost — the dev relaxation must never reach production", async () => {
    const { isOriginAllowed } = await loadWithEnv(prodEnv);

    expect(isOriginAllowed("http://localhost:5173")).toBe(false);
    expect(isOriginAllowed("http://127.0.0.1:5174")).toBe(false);
  });

  it("rejects a different origin, including a near-miss on the same host", async () => {
    const { isOriginAllowed } = await loadWithEnv(prodEnv);

    expect(isOriginAllowed("https://evil.example")).toBe(false);
    expect(isOriginAllowed("http://minutely.pages.dev")).toBe(false);
    expect(isOriginAllowed("https://minutely.pages.dev.evil.example")).toBe(false);
  });
});
