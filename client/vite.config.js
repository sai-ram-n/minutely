import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

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
  plugins: [react(), basicSsl(), requireBackendUrl()],
  server: {
    // Served over HTTPS with a self-signed certificate, and bound to every
    // interface, so ONE url works from any machine on the network.
    //
    // HTTPS is not decoration: getUserMedia only works in a secure context, so
    // over plain http from anything other than localhost the browser blocks the
    // microphone outright and recording silently never starts. Serving https
    // makes the network url a secure context, so the microphone works there.
    //
    // The API stays plain http behind this proxy — the browser only ever talks
    // to this origin, so /api and /ws are https and wss to it, and there is no
    // mixed-content problem and nothing else to configure.
    host: process.env.CLIENT_HOST ?? "0.0.0.0",
    port: Number(process.env.CLIENT_PORT ?? 5173),

    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.PORT ?? 3001}`, changeOrigin: true },
      "/ws": { target: `ws://127.0.0.1:${process.env.PORT ?? 3001}`, ws: true },
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
