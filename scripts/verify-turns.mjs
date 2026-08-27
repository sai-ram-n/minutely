#!/usr/bin/env node
/**
 * Manual verification of silence-gap turn detection against real audio and the
 * real Groq API.
 *
 * two-turns.webm is two passages of speech separated by a deliberate 2.0s
 * silence — comfortably past the 1.5s threshold — so a correct implementation
 * produces two lines with two different speaker labels.
 *
 * Start the server first, then:  node scripts/verify-turns.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIO = resolve(ROOT, "server/tests/fixtures/audio/two-turns.webm");
const PORT = process.env.PORT ?? 3001;

const line = (label) => console.log(`\n${"=".repeat(64)}\n  ${label}\n${"=".repeat(64)}`);

const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
  headers: { Origin: "http://localhost:5173" },
});
const received = [];

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  received.push(message);
  socket.emit("parsed", message);
});

function waitFor(type, timeoutMs = 60_000) {
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

line("uploading two-turns.webm (2.0s silence at ~12s)");
socket.send(JSON.stringify({ type: "start_recording", title: "Turn detection check" }));
const { meetingId } = await waitFor("recording_started");

const audio = readFileSync(AUDIO);
console.log(`  ${(audio.length / 1024).toFixed(0)} KB uploaded`);

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

// Wait for transcription to settle.
await new Promise((r) => setTimeout(r, 12_000));

line("transcript lines produced");
const lines = received.filter((m) => m.type === "transcript_line");
for (const l of lines) {
  console.log(`  [${l.sequence}] ${l.speakerLabel}: ${l.text.slice(0, 68)}…`);
}

const labels = [...new Set(lines.map((l) => l.speakerLabel))];
console.log(`\n  distinct speakers detected: ${labels.length} (${labels.join(", ")})`);
console.log(`  expected: 2, from the deliberate 2.0s silence`);

// ---- Renaming ---------------------------------------------------------------

if (labels.length >= 2) {
  line("renaming Speaker 2 -> Priya");
  const response = await fetch(`http://127.0.0.1:${PORT}/api/meetings/${meetingId}/speakers`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Speaker 2", to: "Priya" }),
  });
  const body = await response.json();
  console.log(`  HTTP ${response.status} — ${body.updated} line(s) updated`);
  console.log(`  speakers now: ${body.speakers?.join(", ")}`);
}

socket.send(JSON.stringify({ type: "stop_recording", meetingId }));
await waitFor("recording_stopped");

line("verification complete");
socket.close();
process.exit(0);
