/**
 * A fake AiProvider for tests.
 *
 * Satisfies the same contract as groqProvider without any network access, so
 * routes and socket handlers can be exercised end to end without spending Groq
 * quota or depending on a live API.
 */

import { vi } from "vitest";

/**
 * @param {Object} [options]
 * @param {import("../../src/ai/provider.js").TranscriptionResult} [options.transcription]
 * @param {import("../../src/ai/provider.js").MinutesResult} [options.minutes]
 * @param {Error} [options.transcribeError] Make transcribe() reject.
 * @param {Error} [options.summarizeError]  Make summarize() reject.
 */
export function createFakeProvider(options = {}) {
  const transcription = options.transcription ?? {
    text: "This is a fake transcription.",
    segments: [{ start: 0, end: 2.5, text: "This is a fake transcription." }],
  };

  const minutes = options.minutes ?? {
    decisions: ["Adopt the fake provider for tests"],
    action_items: [
      { task: "Wire the fake into route tests", owner: "Unassigned", due: "Not specified" },
    ],
    open_questions: [],
  };

  return {
    name: "fake",
    transcribe: vi.fn(async () => {
      if (options.transcribeError) throw options.transcribeError;
      return transcription;
    }),
    summarize: vi.fn(async () => {
      if (options.summarizeError) throw options.summarizeError;
      return minutes;
    }),
  };
}
