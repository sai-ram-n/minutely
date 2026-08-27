/**
 * Overlap dedupe.
 *
 * Adjacent audio chunks deliberately overlap by ~1s so no word is sliced in
 * half at a boundary. That overlap re-transcribes the same words, which must be
 * trimmed before the line is stored — otherwise every chunk boundary shows a
 * visible stutter in the transcript.
 */

import { describe, it, expect } from "vitest";
import { dedupeOverlap } from "../src/services/transcription.js";

describe("dedupeOverlap", () => {
  it("trims words repeated from the end of the previous line", () => {
    const previous = "we should ship the billing rewrite on Friday";
    const next = "on Friday assuming staging comes back clean";

    expect(dedupeOverlap(previous, next)).toBe("assuming staging comes back clean");
  });

  it("trims a long overlap", () => {
    const previous = "the quick brown fox jumps over the lazy dog";
    const next = "jumps over the lazy dog and keeps running";

    expect(dedupeOverlap(previous, next)).toBe("and keeps running");
  });

  it("ignores case when matching", () => {
    expect(dedupeOverlap("we ship on Friday", "On FRIDAY we celebrate")).toBe("we celebrate");
  });

  it("ignores punctuation differences at the boundary", () => {
    // Whisper punctuates each chunk independently, so the same words come back
    // punctuated differently either side of a boundary.
    expect(dedupeOverlap("let's ship it on Friday.", "on Friday, we celebrate")).toBe(
      "we celebrate",
    );
  });

  it("leaves unrelated text untouched", () => {
    const previous = "we should ship on Friday";
    const next = "the pricing question is still open";

    expect(dedupeOverlap(previous, next)).toBe(next);
  });

  it("does not trim on a single repeated word, which is usually legitimate", () => {
    // "the" ending one line and starting the next is ordinary English, not an
    // artefact of the overlap.
    const previous = "we talked about the";
    const next = "the pricing model needs work";

    expect(dedupeOverlap(previous, next)).toBe(next);
  });

  it("returns an empty string when the chunk was entirely overlap", () => {
    expect(dedupeOverlap("we should ship on Friday", "we should ship on Friday")).toBe("");
  });

  it("handles an empty previous line", () => {
    expect(dedupeOverlap("", "first words of the meeting")).toBe("first words of the meeting");
  });

  it("handles an empty new line", () => {
    expect(dedupeOverlap("some previous text", "")).toBe("");
  });

  it("collapses irregular whitespace in the trimmed remainder", () => {
    expect(dedupeOverlap("ship on Friday", "on   Friday    we    celebrate")).toBe(
      "we celebrate",
    );
  });

  it("prefers the longest genuine overlap", () => {
    // "on Friday" also matches, but "ship on Friday" is the real overlap.
    const previous = "we will ship on Friday";
    const next = "ship on Friday without fail";

    expect(dedupeOverlap(previous, next)).toBe("without fail");
  });

  it("respects the search window rather than scanning unbounded history", () => {
    const previous = "a b c d e f g h";
    const next = "e f g h i j";

    // A window wide enough to see the four-word overlap trims it.
    expect(dedupeOverlap(previous, next, 4)).toBe("i j");

    // A narrower window cannot see it, so nothing is trimmed. This bounds the
    // work done per chunk rather than scanning the whole transcript.
    expect(dedupeOverlap(previous, next, 2)).toBe("e f g h i j");
  });

  it("does not trim when only punctuation would match", () => {
    expect(dedupeOverlap("...", "--- the meeting begins")).toBe("--- the meeting begins");
  });
});
