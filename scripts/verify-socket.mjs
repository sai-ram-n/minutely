#!/usr/bin/env node
/**
 * Manual end-to-end verification of the meeting WebSocket against a running
 * server and the real Groq API.
 *
 * Acts as a browser would: connect, start a recording, upload overlapping audio
 * chunks, and print the transcript lines that come back.
 *
 * Start the server first, then:  node scripts/verify-socket.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIO_DIR = resolve(ROOT, "server", "tests", "fixtures", "audio");
const PORT = process.env.PORT ?? 3001;
const URL = `ws://127.0.0.1:${PORT}/ws`;

const CHUNKS = ["chunk-000.webm", "chunk-001.webm"];

const line = (label) => console.log(`\n${"=".repeat(64)}\n  ${label}\n${"=".repeat(64)}`);

line(`connecting to ${URL}`);

const socket = new WebSocket(URL, { headers: { Origin: "http://localhost:5173" } });
const received = [];

function waitFor(type, timeoutMs = 60_000) {
  const existing = received.find((m) => m.type === type);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${type}"`)),
      timeoutMs,
    );
    const check = (message) => {
      if (message.type === type) {
        clearTimeout(timer);
        socket.off("parsed", check);
        resolve(message);
      }
    };
    socket.on("parsed", check);
  });
}

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  received.push(message);
  socket.emit("parsed", message);

  if (message.type === "transcript_line") {
    console.log(`  [${message.sequence}] ${message.speakerLabel}: ${message.text}`);
  } else if (message.type === "transcription_error") {
    console.log(`  ! transcription_error: ${message.message}`);
  } else if (message.type === "error") {
    console.log(`  ! error: ${message.message}`);
  } else {
    console.log(`  <- ${message.type}${message.meetingId ? ` (${message.meetingId.slice(0, 8)}…)` : ""}`);
  }
});

await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
console.log("  connected");

// ---- 1. Malformed input must not kill the connection ------------------------

line("malformed input (the connection must survive)");
socket.send("this is not json");
await waitFor("error", 5000);
socket.send(JSON.stringify({ type: "audio_chunk", meetingId: "not-a-uuid", data: "@@@", sequence: 0 }));
await new Promise((r) => setTimeout(r, 300));
console.log(`  connection still open: ${socket.readyState === WebSocket.OPEN}`);

// ---- 2. A real recording ----------------------------------------------------

line("start_recording");
socket.send(JSON.stringify({ type: "start_recording", title: "Socket verification run" }));
const started = await waitFor("recording_started");
const meetingId = started.meetingId;

line("uploading overlapping audio chunks through the socket");
for (const [index, name] of CHUNKS.entries()) {
  const audio = readFileSync(resolve(AUDIO_DIR, name));
  console.log(`  -> ${name} (${(audio.length / 1024).toFixed(0)} KB) as sequence ${index}`);

  socket.send(
    JSON.stringify({
      type: "audio_chunk",
      meetingId,
      data: audio.toString("base64"),
      sequence: index,
      mimeType: "audio/webm",
      startOffsetMs: index * 19_000,
      overlapMs: index === 0 ? 0 : 1000,
    }),
  );
}

// Both chunks must produce a line before we stop.
const deadline = Date.now() + 60_000;
while (received.filter((m) => m.type === "transcript_line").length < CHUNKS.length) {
  if (Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 200));
}

line("stop_recording");
socket.send(JSON.stringify({ type: "stop_recording", meetingId }));
await waitFor("recording_stopped");

// ---- 3. Reconnect and resume ------------------------------------------------

line("resume_recording (what a reconnecting client sends)");
socket.send(JSON.stringify({ type: "resume_recording", meetingId, lastSequence: -1 }));
const resumed = await waitFor("resumed");
console.log(`  server replayed ${resumed.lines.length} line(s)`);
for (const l of resumed.lines) console.log(`    [${l.sequence}] ${l.speakerLabel}: ${l.text.slice(0, 70)}…`);

line("verification complete");
socket.close();
process.exit(0);
