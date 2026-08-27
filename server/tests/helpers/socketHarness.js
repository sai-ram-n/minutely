/**
 * Spins up a real HTTP server with the meeting WebSocket attached, backed by a
 * fake AiProvider. Exercises the actual socket code path with no network calls.
 */

import { createServer } from "node:http";
import { WebSocket } from "ws";
import { attachMeetingSocket } from "../../src/ws/meetingSocket.js";

/**
 * @param {Object} [options]
 * @param {import("../../src/ai/provider.js").AiProvider} options.provider
 * @param {(meetingId: string) => Promise<void>} [options.onFinalize]
 */
export async function startTestServer(options = {}) {
  const server = createServer();
  const wss = attachMeetingSocket(server, options);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A connected client that records every message it receives and can wait for
 * one of a given type.
 * @param {string} url
 * @param {Object} [options]
 */
export async function connect(url, options = {}) {
  const socket = new WebSocket(url, options);
  const received = [];
  /** @type {{ type: string, resolve: Function }[]} */
  const waiters = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);

    const index = waiters.findIndex((w) => w.type === message.type);
    if (index !== -1) waiters.splice(index, 1)[0].resolve(message);
  });

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    socket,
    received,
    send: (payload) =>
      socket.send(typeof payload === "string" ? payload : JSON.stringify(payload)),

    /** Resolves with the next message of `type`, or rejects on timeout. */
    waitFor(type, timeoutMs = 3000) {
      const existing = received.find((m) => m.type === type);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for "${type}"; received: ${received.map((m) => m.type).join(", ") || "(nothing)"}`,
            ),
          );
        }, timeoutMs);

        waiters.push({
          type,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },

    close() {
      return new Promise((resolve) => {
        if (socket.readyState === socket.CLOSED) return resolve();
        socket.once("close", resolve);
        socket.close();
      });
    },
  };
}

/** Waits for a connection rejection during the upgrade handshake. */
export function expectUpgradeRejected(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => {
      socket.close();
      reject(new Error("expected the upgrade to be rejected, but it succeeded"));
    });
    socket.once("error", (err) => resolve(err));
  });
}
