/**
 * Where the API and WebSocket live.
 *
 * In dev, Vite proxies /api and /ws to the local server, so same-origin works
 * and there is nothing to configure. In production the frontend is on
 * Cloudflare Pages and the backend on Render, so both are set at build time.
 *
 * The page is served over HTTPS in production, so the socket MUST be wss://:
 * a ws:// socket from an https:// page is blocked as mixed content.
 */

const env = import.meta.env ?? {};

export const API_BASE = env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export function websocketUrl() {
  if (env.VITE_WS_URL) return env.VITE_WS_URL;

  const { protocol, host } = globalThis.location ?? { protocol: "http:", host: "localhost:5173" };
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws`;
}
