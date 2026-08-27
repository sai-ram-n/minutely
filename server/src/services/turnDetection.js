/**
 * Speaker turn detection from silence gaps.
 *
 * WHAT THIS IS NOT: speaker identification. No free hosted diarization API
 * exists, so this cannot tell you WHO is talking — only that the speaker
 * probably CHANGED. A pause longer than the threshold is treated as a turn
 * boundary and the label advances. That is stated in the UI, not buried here.
 *
 * Timings come from Whisper's verbose_json segments. They are relative to the
 * start of their own audio chunk, so each is offset by the chunk's position in
 * the meeting — otherwise a pause spanning a chunk boundary would be invisible.
 *
 * Every function here is pure. State is passed in and returned, never held in a
 * module-level variable, so the behaviour is directly testable.
 */

/** A pause longer than this suggests someone else started talking. */
export const DEFAULT_GAP_THRESHOLD_MS = 1500;

/**
 * How many generic labels to cycle through. Two suits the common case; with
 * more speakers the labels will be wrong, which is why renaming exists and why
 * the UI says so plainly.
 */
export const DEFAULT_SPEAKER_COUNT = 2;

/**
 * @typedef {Object} TurnState
 * @property {number} speakerIndex   Zero-based index of the current speaker
 * @property {number | null} lastEndMs  Absolute ms into the meeting where
 *                                      speech last stopped; null before any
 */

/**
 * @typedef {Object} Turn
 * @property {number} speakerIndex
 * @property {string} text
 * @property {number} startMs  Absolute ms into the meeting
 * @property {number} endMs
 */

/** @returns {TurnState} */
export function initialTurnState() {
  return { speakerIndex: 0, lastEndMs: null };
}

/**
 * "Speaker 1", "Speaker 2", …
 * @param {number} index Zero-based
 */
export function speakerLabel(index) {
  return `Speaker ${index + 1}`;
}

/**
 * Recovers the speaker index from a stored label, so a server restart
 * mid-meeting does not reset everyone to Speaker 1.
 * @param {string | null | undefined} label
 * @returns {number} Zero-based; 0 when the label is absent or renamed.
 */
export function speakerIndexFromLabel(label) {
  const match = /^Speaker (\d+)$/.exec(String(label ?? ""));
  if (!match) return 0;
  return Math.max(0, Number(match[1]) - 1);
}

/**
 * Groups a chunk's segments into speaker turns.
 *
 * @param {import("../ai/provider.js").TranscriptSegment[] | undefined} segments
 * @param {Object} options
 * @param {TurnState} options.state
 * @param {number} [options.startOffsetMs] Where this chunk sits in the meeting.
 * @param {number} [options.gapThresholdMs]
 * @param {number} [options.speakerCount]
 * @param {string} [options.fallbackText]
 *   Used when the provider returned no segments: the whole chunk becomes one
 *   turn attributed to the current speaker, rather than being dropped.
 * @returns {{ turns: Turn[], state: TurnState }}
 */
export function detectTurns(segments, options) {
  const {
    state,
    startOffsetMs = 0,
    gapThresholdMs = DEFAULT_GAP_THRESHOLD_MS,
    speakerCount = DEFAULT_SPEAKER_COUNT,
    fallbackText,
  } = options;

  const usable = (segments ?? []).filter(
    (segment) => typeof segment?.text === "string" && segment.text.trim() !== "",
  );

  // No timings available: attribute the whole chunk to whoever is speaking.
  // A provider without segment support still produces a usable transcript.
  if (usable.length === 0) {
    const text = (fallbackText ?? "").trim();
    if (text === "") return { turns: [], state };

    return {
      turns: [
        {
          speakerIndex: state.speakerIndex,
          text,
          startMs: startOffsetMs,
          endMs: startOffsetMs,
        },
      ],
      state: { ...state, lastEndMs: state.lastEndMs },
    };
  }

  /** @type {Turn[]} */
  const turns = [];
  let { speakerIndex, lastEndMs } = state;

  for (const segment of usable) {
    const startMs = startOffsetMs + Math.round(segment.start * 1000);
    const endMs = startOffsetMs + Math.round(segment.end * 1000);

    // A gap is only meaningful once somebody has already spoken.
    if (lastEndMs !== null) {
      const gapMs = startMs - lastEndMs;
      if (gapMs >= gapThresholdMs) {
        speakerIndex = (speakerIndex + 1) % speakerCount;
      }
    }

    const current = turns[turns.length - 1];

    if (current && current.speakerIndex === speakerIndex) {
      // Same speaker still talking: extend the turn rather than starting a new
      // line for every Whisper segment.
      current.text = `${current.text} ${segment.text.trim()}`.trim();
      current.endMs = endMs;
    } else {
      turns.push({
        speakerIndex,
        text: segment.text.trim(),
        startMs,
        endMs,
      });
    }

    lastEndMs = endMs;
  }

  return { turns, state: { speakerIndex, lastEndMs } };
}
