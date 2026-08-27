/**
 * Client configuration.
 *
 * The WebSocket URL must be derived from the API origin, never from the page's
 * own location in production — the static host has no WebSocket server, and
 * getting this wrong fails silently at connection time.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

/** Reloads config.js with a given import.meta.env and window.location. */
async function loadConfig({ apiUrl, wsUrl, location } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_API_URL", apiUrl ?? "");
  vi.stubEnv("VITE_WS_URL", wsUrl ?? "");

  if (location) {
    vi.stubGlobal("location", location);
  }
  return import("./config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("API_BASE", () => {
  it("is empty in dev, so requests go same-origin through the proxy", async () => {
    const { API_BASE, hasExplicitBackend } = await loadConfig();
    expect(API_BASE).toBe("");
    expect(hasExplicitBackend).toBe(false);
  });

  it("uses the configured backend origin", async () => {
    const { API_BASE, hasExplicitBackend } = await loadConfig({
      apiUrl: "https://minutely-api.onrender.com",
    });
    expect(API_BASE).toBe("https://minutely-api.onrender.com");
    expect(hasExplicitBackend).toBe(true);
  });

  it("strips trailing slashes so paths do not double up", async () => {
    const { API_BASE } = await loadConfig({ apiUrl: "https://minutely-api.onrender.com///" });
    expect(API_BASE).toBe("https://minutely-api.onrender.com");
  });
});

describe("websocketUrl", () => {
  it("derives wss:// from an https backend", async () => {
    const { websocketUrl } = await loadConfig({ apiUrl: "https://minutely-api.onrender.com" });
    expect(websocketUrl()).toBe("wss://minutely-api.onrender.com/ws");
  });

  it("derives ws:// from an http backend", async () => {
    const { websocketUrl } = await loadConfig({ apiUrl: "http://localhost:3001" });
    expect(websocketUrl()).toBe("ws://localhost:3001/ws");
  });

  it("does NOT point at the page's own host when a backend is configured", async () => {
    // The bug this guards: on a static host, deriving from location gives
    // wss://<pages-host>/ws, which has no WebSocket server.
    const { websocketUrl } = await loadConfig({
      apiUrl: "https://minutely-api.onrender.com",
      location: { protocol: "https:", host: "minutely.pages.dev" },
    });

    expect(websocketUrl()).toBe("wss://minutely-api.onrender.com/ws");
    expect(websocketUrl()).not.toContain("pages.dev");
  });

  it("falls back to same-origin in dev", async () => {
    const { websocketUrl } = await loadConfig({
      location: { protocol: "http:", host: "localhost:5173" },
    });
    expect(websocketUrl()).toBe("ws://localhost:5173/ws");
  });

  it("upgrades to wss when the dev page itself is https", async () => {
    const { websocketUrl } = await loadConfig({
      location: { protocol: "https:", host: "example.test" },
    });
    // ws:// from an https:// page is blocked as mixed content.
    expect(websocketUrl()).toBe("wss://example.test/ws");
  });

  it("honours an explicit override for unusual setups", async () => {
    const { websocketUrl } = await loadConfig({
      apiUrl: "https://minutely-api.onrender.com",
      wsUrl: "wss://sockets.example.com/ws",
    });
    expect(websocketUrl()).toBe("wss://sockets.example.com/ws");
  });
});
