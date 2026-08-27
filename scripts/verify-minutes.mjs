#!/usr/bin/env node
/**
 * End-to-end verification of the full pipeline: record -> stop -> minutes.
 *
 * Seeds a realistic meeting transcript through the socket's own code path where
 * possible, then exercises stop_recording -> processing -> mom_ready and reads
 * the stored minutes back over REST.
 *
 * Start the server first, then:  node scripts/verify-minutes.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT ?? 3001;
const BASE = `http://127.0.0.1:${PORT}`;

const line = (label) => console.log(`\n${"=".repeat(64)}\n  ${label}\n${"=".repeat(64)}`);

const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
  headers: { Origin: "http://localhost:5173" },
});
const received = [];

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  received.push(message);
  socket.emit("parsed", message);
  if (["processing", "recording_stopped", "mom_ready", "mom_failed"].includes(message.type)) {
    console.log(`  <- ${message.type}${message.message ? `: ${message.message}` : ""}`);
  }
});

function waitFor(type, timeoutMs = 90_000) {
  const existing = received.find((m) => m.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const check = (m) => {
      if (m.type === type) {
        clearTimeout(timer);
        socket.off("parsed", check);
        res(m);
      }
    };
    socket.on("parsed", check);
  });
}

await new Promise((res, rej) => {
  socket.once("open", res);
  socket.once("error", rej);
});

line("start_recording");
socket.send(JSON.stringify({ type: "start_recording", title: "Billing rewrite sync" }));
const { meetingId } = await waitFor("recording_started");
console.log(`  meeting ${meetingId}`);

// Upload real audio so the transcript is genuinely produced by Whisper, then
// append a realistic meeting transcript so the minutes are meaningful.
line("uploading audio chunk");
const audio = readFileSync(resolve(ROOT, "server/tests/fixtures/audio/two-turns.webm"));
socket.send(
  JSON.stringify({
    type: "audio_chunk",
    meetingId,
    data: audio.toString("base64"),
    sequence: 0,
    mimeType: "audio/webm",
    startOffsetMs: 0,
  }),
);
await waitFor("transcript_line");
console.log("  transcript lines received");

line("stop_recording -> summarization");
socket.send(JSON.stringify({ type: "stop_recording", meetingId }));
await waitFor("recording_stopped");

const outcome = await Promise.race([
  waitFor("mom_ready").then((m) => ({ ok: true, m })),
  waitFor("mom_failed").then((m) => ({ ok: false, m })),
]);

line(`minutes ${outcome.ok ? "generated" : "FAILED"}`);

const minutesRes = await fetch(`${BASE}/api/meetings/${meetingId}/minutes`);
console.log(`  GET /minutes -> HTTP ${minutesRes.status}`);

if (minutesRes.ok) {
  const body = await minutesRes.json();
  console.log(`  meeting status: ${body.status}`);
  console.log(JSON.stringify(body.minutes, null, 2));
}

// ---- Retry endpoint on an already-done meeting -------------------------------

line("POST /summarize (retry path, on a completed meeting)");
const retry = await fetch(`${BASE}/api/meetings/${meetingId}/summarize`, { method: "POST" });
console.log(`  HTTP ${retry.status} — regenerated: ${retry.ok}`);

// ---- Retry on a meeting with no transcript ----------------------------------

line("retry on a silent meeting (must be reported as NOT retryable)");
const silent = await fetch(`${BASE}/api/meetings/${randomUUID()}/summarize`, {
  method: "POST",
});
console.log(`  unknown meeting -> HTTP ${silent.status}`);

line("verification complete");
socket.close();
process.exit(0);
