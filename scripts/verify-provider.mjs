#!/usr/bin/env node
/**
 * Manual end-to-end verification of the real AiProvider against the real Groq API.
 *
 * Not part of `npm test`: it needs network and a real key, and it spends quota.
 * Run it when you change the provider or want to confirm live wiring:
 *
 *     node scripts/verify-provider.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = resolve(ROOT, "server", "tests", "fixtures");

const { getProvider } = await import(resolve(ROOT, "server/src/ai/index.js"));
const provider = getProvider();

const line = (label) => console.log(`\n${"=".repeat(64)}\n  ${label}\n${"=".repeat(64)}`);

// ---- 1. Transcription against saved audio ----------------------------------

line("transcribe() — server/tests/fixtures/audio/sample-speech.webm");

const audio = readFileSync(resolve(FIXTURES, "audio", "sample-speech.webm"));
console.log(`  input: ${(audio.length / 1024).toFixed(1)} KB of webm/opus\n`);

const started = Date.now();
const transcription = await provider.transcribe(audio, { mimeType: "audio/webm" });
console.log(`  latency:  ${Date.now() - started} ms`);
console.log(`  segments: ${transcription.segments?.length ?? 0}`);
console.log(`  text:     ${transcription.text.slice(0, 400)}${transcription.text.length > 400 ? "…" : ""}`);

if (transcription.segments?.length) {
  console.log("\n  first 5 segments (start -> end):");
  for (const s of transcription.segments.slice(0, 5)) {
    console.log(`    ${s.start.toFixed(2).padStart(6)} -> ${s.end.toFixed(2).padStart(6)}  ${s.text.slice(0, 58)}`);
  }
}

// ---- 2. Silence gaps, which Phase 4 turn detection will consume -------------

line("transcribe() — two-turns.webm (known 2.0s silence at ~12s)");

const twoTurns = readFileSync(resolve(FIXTURES, "audio", "two-turns.webm"));
const turnResult = await provider.transcribe(twoTurns, { mimeType: "audio/webm" });
const segments = turnResult.segments ?? [];
console.log(`  segments: ${segments.length}`);

let biggest = { gap: 0, at: 0 };
for (let i = 1; i < segments.length; i += 1) {
  const gap = segments[i].start - segments[i - 1].end;
  if (gap > biggest.gap) biggest = { gap, at: segments[i - 1].end };
}
console.log(`  largest inter-segment gap: ${biggest.gap.toFixed(2)}s at ~${biggest.at.toFixed(2)}s`);
console.log(`  (expected: a gap around the 12s mark — this is what turn detection keys on)`);

// ---- 3. Summarization against a saved transcript ----------------------------

line("summarize() — server/tests/fixtures/transcripts/sample-meeting.txt");

const transcript = readFileSync(resolve(FIXTURES, "transcripts", "sample-meeting.txt"), "utf8");
const sumStarted = Date.now();
const minutes = await provider.summarize(transcript);
console.log(`  latency: ${Date.now() - sumStarted} ms\n`);
console.log(JSON.stringify(minutes, null, 2));

line("all provider calls succeeded");
