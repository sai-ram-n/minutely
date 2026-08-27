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

describe("development — LAN access", () => {
  const devEnv = { NODE_ENV: "development", FRONTEND_ORIGIN: "http://localhost:5173" };

  it("allows private LAN addresses, so the dev server is reachable from another machine", async () => {
    const { isOriginAllowed } = await loadWithEnv(devEnv);

    expect(isOriginAllowed("http://192.168.21.112:5174")).toBe(true);
    expect(isOriginAllowed("http://10.1.2.3:5173")).toBe(true);
    expect(isOriginAllowed("http://172.20.0.1:5173")).toBe(true);
  });

  it("rejects public addresses even in development", async () => {
    const { isOriginAllowed } = await loadWithEnv(devEnv);

    expect(isOriginAllowed("http://8.8.8.8:5173")).toBe(false);
    expect(isOriginAllowed("https://evil.example")).toBe(false);
  });

  it("respects the edges of the 172.16/12 private range", async () => {
    const { isOriginAllowed } = await loadWithEnv(devEnv);

    // 172.16-172.31 are private; 172.15 and 172.32 are not.
    expect(isOriginAllowed("http://172.16.0.1:5173")).toBe(true);
    expect(isOriginAllowed("http://172.31.255.254:5173")).toBe(true);
    expect(isOriginAllowed("http://172.15.0.1:5173")).toBe(false);
    expect(isOriginAllowed("http://172.32.0.1:5173")).toBe(false);
  });

  it("is not fooled by a public host that merely starts with a private prefix", async () => {
    const { isOriginAllowed } = await loadWithEnv(devEnv);

    expect(isOriginAllowed("http://192.168.21.112.evil.example")).toBe(false);
    expect(isOriginAllowed("http://10.1.2.3.attacker.test")).toBe(false);
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

  it("rejects private LAN addresses in production too", async () => {
    const { isOriginAllowed } = await loadWithEnv(prodEnv);

    expect(isOriginAllowed("http://192.168.21.112:5174")).toBe(false);
    expect(isOriginAllowed("http://10.1.2.3:5173")).toBe(false);
  });

  it("rejects a different origin, including a near-miss on the same host", async () => {
    const { isOriginAllowed } = await loadWithEnv(prodEnv);

    expect(isOriginAllowed("https://evil.example")).toBe(false);
    expect(isOriginAllowed("http://minutely.pages.dev")).toBe(false);
    expect(isOriginAllowed("https://minutely.pages.dev.evil.example")).toBe(false);
  });
});
