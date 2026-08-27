import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Fails a production build that has no backend configured.
 *
 * The frontend and backend are deployed to different hosts, so a production
 * build without VITE_API_URL produces an app that cannot reach its API and
 * whose WebSocket points at the static host. That failure is invisible until
 * someone opens the deployed site, which is the worst time to find it.
 *
 * Opt into a same-origin build with VITE_SAME_ORIGIN=true.
 */
function requireBackendUrl() {
  return {
    name: "minutely:require-backend-url",
    apply: "build",
    config(_config, { mode }) {
      if (mode !== "production") return;
      if (process.env.VITE_SAME_ORIGIN === "true") return;
      if (process.env.VITE_API_URL) return;

      throw new Error(
        [
          "",
          "  Production build is missing VITE_API_URL.",
          "",
          "  The frontend and backend live on different hosts, so the client needs",
          "  to be told where the backend is. Set it to your deployed backend origin:",
          "",
          "      VITE_API_URL=https://your-service.onrender.com",
          "",
          "  The WebSocket URL is derived from it automatically.",
          "  If you really are serving both from one origin, set VITE_SAME_ORIGIN=true.",
          "",
        ].join("\n"),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), requireBackendUrl()],
  server: {
    // Bind IPv4 explicitly. With no host set, Vite will happily bind IPv6-only
    // when the IPv4 port is already taken — producing two dev servers on "the
    // same" port that resolve differently depending on the client. Painful to
    // debug, and this box already has another project on 5173.
    host: process.env.CLIENT_HOST ?? "127.0.0.1",
    port: Number(process.env.CLIENT_PORT ?? 5173),
    // Dev-only convenience: the client talks to the API and socket on the same
    // origin, so no CORS or URL juggling locally. Production points at the
    // deployed backend via VITE_API_URL / VITE_WS_URL.
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{js,jsx}"],
    globals: true,
    setupFiles: ["./src/test/setup.js"],
  },
});
