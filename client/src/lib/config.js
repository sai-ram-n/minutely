/**
 * Where the API and WebSocket live.
 *
 * ONE variable to set for a deploy: VITE_API_URL, pointing at the backend.
 * The WebSocket URL is derived from it, because deriving it from the page's own
 * location would silently point at the static host — which has no WebSocket
 * server — and produce a connection failure with no obvious cause.
 *
 * In dev nothing needs setting: Vite proxies /api and /ws to the local server,
 * so same-origin works.
 *
 * The page is served over HTTPS in production, so the socket MUST be wss://:
 * a ws:// socket from an https:// page is blocked as mixed content, which the
 * derivation below handles automatically.
 */

const env = import.meta.env ?? {};

/** Backend origin, without a trailing slash. Empty in dev (same-origin proxy). */
export const API_BASE = (env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** True when this build was configured to talk to a separate backend. */
export const hasExplicitBackend = API_BASE !== "";

/**
 * @param {string} httpUrl
 * @returns {string} the same origin with an ws/wss scheme
 */
function toWebSocketUrl(httpUrl) {
  return httpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

export function websocketUrl() {
  // Explicit override, for setups where the socket is not on the API origin.
  if (env.VITE_WS_URL) return env.VITE_WS_URL;

  // Derived from the API origin — the normal production path.
  if (hasExplicitBackend) return `${toWebSocketUrl(API_BASE)}/ws`;

  // Dev: same origin, through the Vite proxy.
  const { protocol, host } = globalThis.location ?? {
    protocol: "http:",
    host: "localhost:5173",
  };
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws`;
}
