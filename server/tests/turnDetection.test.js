/**
 * Silence-gap turn detection.
 *
 * The spec's requirement: given a sequence of chunk timestamps, assert the
 * correct speaker-boundary calls. Everything here is a pure function, so the
 * boundaries are asserted exactly — no audio, no API.
 */

import { describe, it, expect } from "vitest";
import {
  detectTurns,
  initialTurnState,
  speakerLabel,
  speakerIndexFromLabel,
  DEFAULT_GAP_THRESHOLD_MS,
} from "../src/services/turnDetection.js";

/** Builds segments from [startSeconds, endSeconds, text] triples. */
function segments(...triples) {
  return triples.map(([start, end, text]) => ({ start, end, text }));
}

const fresh = () => initialTurnState();

describe("speakerLabel", () => {
  it("is one-based for humans", () => {
    expect(speakerLabel(0)).toBe("Speaker 1");
    expect(speakerLabel(1)).toBe("Speaker 2");
  });
});

describe("speakerIndexFromLabel", () => {
  it("round-trips a generated label", () => {
    expect(speakerIndexFromLabel(speakerLabel(1))).toBe(1);
  });

  it("falls back to the first speaker for a renamed or missing label", () => {
    // Once renamed to "Priya" the index is unrecoverable; starting over is
    // better than crashing or guessing.
    expect(speakerIndexFromLabel("Priya")).toBe(0);
    expect(speakerIndexFromLabel(null)).toBe(0);
    expect(speakerIndexFromLabel(undefined)).toBe(0);
  });
});

describe("detectTurns — boundaries", () => {
  it("keeps one speaker when pauses are short", () => {
    const { turns } = detectTurns(
      segments([0, 2, "we should ship"], [2.3, 4, "on Friday"]),
      { state: fresh() },
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].speakerIndex).toBe(0);
    expect(turns[0].text).toBe("we should ship on Friday");
  });

  it("starts a new speaker after a pause at the threshold", () => {
    // 2.0s -> 3.5s is exactly 1500ms.
    const { turns } = detectTurns(
      segments([0, 2, "we should ship on Friday"], [3.5, 5, "I disagree"]),
      { state: fresh() },
    );

    expect(turns).toHaveLength(2);
    expect(turns[0].speakerIndex).toBe(0);
    expect(turns[1].speakerIndex).toBe(1);
  });

  it("does NOT switch on a pause just below the threshold", () => {
    const { turns } = detectTurns(
      segments([0, 2, "we should ship"], [3.499, 5, "on Friday"]),
      { state: fresh() },
    );

    expect(turns).toHaveLength(1);
  });

  it("alternates back on a second long pause", () => {
    const { turns } = detectTurns(
      segments(
        [0, 2, "first speaker"],
        [4, 6, "second speaker"],
        [8, 10, "first speaker again"],
      ),
      { state: fresh() },
    );

    expect(turns.map((t) => t.speakerIndex)).toEqual([0, 1, 0]);
    expect(turns.map((t) => t.text)).toEqual([
      "first speaker",
      "second speaker",
      "first speaker again",
    ]);
  });

  it("honours a custom gap threshold", () => {
    const options = { state: fresh(), gapThresholdMs: 3000 };
    const { turns } = detectTurns(
      segments([0, 2, "one"], [4, 6, "two"]),
      options,
    );

    // A 2s gap is a boundary at the default but not at 3s.
    expect(turns).toHaveLength(1);
  });

  it("cycles through more than two speakers when configured", () => {
    const { turns } = detectTurns(
      segments([0, 1, "a"], [3, 4, "b"], [6, 7, "c"], [9, 10, "d"]),
      { state: fresh(), speakerCount: 3 },
    );

    expect(turns.map((t) => t.speakerIndex)).toEqual([0, 1, 2, 0]);
  });

  it("merges consecutive segments from the same speaker into one turn", () => {
    const { turns } = detectTurns(
      segments([0, 1, "one"], [1.1, 2, "two"], [2.1, 3, "three"]),
      { state: fresh() },
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("one two three");
    expect(turns[0].startMs).toBe(0);
    expect(turns[0].endMs).toBe(3000);
  });
});

describe("detectTurns — chunk offsets", () => {
  it("offsets segment times by the chunk's position in the meeting", () => {
    const { turns } = detectTurns(segments([0, 2, "hello"]), {
      state: fresh(),
      startOffsetMs: 60_000,
    });

    expect(turns[0].startMs).toBe(60_000);
    expect(turns[0].endMs).toBe(62_000);
  });

  it("detects a pause that spans a chunk boundary", () => {
    // This is the case the whole offset mechanism exists for: without it, the
    // second chunk's times restart at zero and the gap is invisible.
    const first = detectTurns(segments([0, 19, "end of the first chunk"]), {
      state: fresh(),
      startOffsetMs: 0,
    });

    const second = detectTurns(segments([0, 2, "start of the second"]), {
      state: first.state,
      startOffsetMs: 21_000, // 2s after the previous segment ended
    });

    expect(second.turns[0].speakerIndex).toBe(1);
  });

  it("does not invent a boundary when chunks butt up against each other", () => {
    const first = detectTurns(segments([0, 20, "continuous speech"]), {
      state: fresh(),
      startOffsetMs: 0,
    });

    const second = detectTurns(segments([0, 2, "carrying straight on"]), {
      state: first.state,
      startOffsetMs: 20_000, // no gap at all
    });

    expect(second.turns[0].speakerIndex).toBe(0);
  });

  it("carries the speaker across chunks with no boundary", () => {
    const first = detectTurns(segments([0, 2, "a"], [4, 6, "b"]), {
      state: fresh(),
    });
    expect(first.state.speakerIndex).toBe(1);

    const second = detectTurns(segments([0, 1, "c"]), {
      state: first.state,
      startOffsetMs: 6_200,
    });
    expect(second.turns[0].speakerIndex).toBe(1);
  });
});

describe("detectTurns — degraded input", () => {
  it("treats the whole chunk as one turn when the provider gave no segments", () => {
    const { turns } = detectTurns(undefined, {
      state: fresh(),
      fallbackText: "no timings were available",
      startOffsetMs: 5000,
    });

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("no timings were available");
    expect(turns[0].speakerIndex).toBe(0);
  });

  it("keeps the current speaker in the fallback path", () => {
    const { turns } = detectTurns([], {
      state: { speakerIndex: 1, lastEndMs: 1000 },
      fallbackText: "still speaker two",
    });

    expect(turns[0].speakerIndex).toBe(1);
  });

  it("returns nothing when there are no segments and no fallback text", () => {
    const { turns } = detectTurns([], { state: fresh() });
    expect(turns).toEqual([]);
  });

  it("ignores empty and whitespace-only segments", () => {
    const { turns } = detectTurns(
      segments([0, 1, "real text"], [1.1, 1.2, "   "], [1.3, 2, "more text"]),
      { state: fresh() },
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("real text more text");
  });

  it("does not treat the very first segment as a boundary", () => {
    // There is no previous speech, so a large start time is not a pause.
    const { turns } = detectTurns(segments([30, 32, "late start"]), {
      state: fresh(),
    });

    expect(turns[0].speakerIndex).toBe(0);
  });

  it("survives malformed segments without throwing", () => {
    const { turns } = detectTurns(
      [{ start: 0, end: 1, text: "fine" }, { start: 2 }, null, { text: "" }],
      { state: fresh() },
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("fine");
  });
});

describe("detectTurns — state threading", () => {
  it("returns state that reflects the last segment end", () => {
    const { state } = detectTurns(segments([0, 2, "one"], [2.2, 4.5, "two"]), {
      state: fresh(),
      startOffsetMs: 1000,
    });

    expect(state.lastEndMs).toBe(5500);
  });

  it("does not mutate the state it was given", () => {
    const before = fresh();
    const snapshot = { ...before };

    detectTurns(segments([0, 2, "one"], [5, 6, "two"]), { state: before });

    expect(before).toEqual(snapshot);
  });

  it("uses the documented default threshold", () => {
    expect(DEFAULT_GAP_THRESHOLD_MS).toBe(1500);
  });
});
