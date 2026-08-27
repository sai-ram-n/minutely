/**
 * Chunked recorder timing.
 *
 * The overlap scheme is the whole reason this module exists instead of a plain
 * MediaRecorder timeslice, so the timing is asserted precisely with fake timers
 * and a fake recorder — no real microphone involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChunkedRecorder } from "./audioRecorder.js";

/** Minimal stand-in for MediaRecorder that records how it was driven. */
class FakeRecorder {
  static instances = [];

  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = "inactive";
    this.startedAt = null;
    this.stoppedAt = null;
    FakeRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
    this.startedAt = Date.now();
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.stoppedAt = Date.now();
    // A real recorder emits its buffered data, then fires onstop.
    this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

const CHUNK_MS = 20_000;
const OVERLAP_MS = 1_000;

function build(onChunk) {
  return createChunkedRecorder({
    stream: /** @type {any} */ ({}),
    chunkMs: CHUNK_MS,
    overlapMs: OVERLAP_MS,
    onChunk,
    createRecorder: (stream, options) => new FakeRecorder(stream, options),
    now: () => Date.now(),
  });
}

beforeEach(() => {
  FakeRecorder.instances = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-27T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createChunkedRecorder", () => {
  it("rejects an overlap that is not smaller than the chunk", () => {
    expect(() =>
      createChunkedRecorder({
        stream: {},
        chunkMs: 1000,
        overlapMs: 1000,
        onChunk: () => {},
        createRecorder: () => new FakeRecorder(),
      }),
    ).toThrow(/smaller than chunkMs/);
  });

  it("starts one recorder immediately", () => {
    const recorder = build(() => {});
    recorder.start();

    expect(FakeRecorder.instances).toHaveLength(1);
    expect(FakeRecorder.instances[0].state).toBe("recording");
  });

  it("emits nothing before the first boundary", () => {
    const chunks = [];
    const recorder = build((c) => chunks.push(c));
    recorder.start();

    vi.advanceTimersByTime(CHUNK_MS - 1);
    expect(chunks).toHaveLength(0);
  });

  it("starts the next recorder overlapMs BEFORE stopping the current one", () => {
    const recorder = build(() => {});
    recorder.start();

    // Just before the overlap window opens: still a single recorder.
    vi.advanceTimersByTime(CHUNK_MS - OVERLAP_MS - 1);
    expect(FakeRecorder.instances).toHaveLength(1);

    // Overlap window open: two recorders running against the same stream.
    vi.advanceTimersByTime(2);
    expect(FakeRecorder.instances).toHaveLength(2);
    expect(FakeRecorder.instances[0].state).toBe("recording");
    expect(FakeRecorder.instances[1].state).toBe("recording");

    // At the boundary the first stops, leaving one again.
    vi.advanceTimersByTime(OVERLAP_MS);
    expect(FakeRecorder.instances[0].state).toBe("inactive");
    expect(FakeRecorder.instances[1].state).toBe("recording");
  });

  it("emits chunk 0 at the first boundary with sequence 0 and no overlap", () => {
    const chunks = [];
    const recorder = build((c) => chunks.push(c));
    recorder.start();

    vi.advanceTimersByTime(CHUNK_MS);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].sequence).toBe(0);
    expect(chunks[0].startOffsetMs).toBe(0);
    // The first chunk has nothing before it to overlap with.
    expect(chunks[0].overlapMs).toBe(0);
    expect(chunks[0].blob.size).toBeGreaterThan(0);
  });

  it("emits later chunks with an overlap and a correct start offset", () => {
    const chunks = [];
    const recorder = build((c) => chunks.push(c));
    recorder.start();

    vi.advanceTimersByTime(CHUNK_MS * 2);

    expect(chunks).toHaveLength(2);
    expect(chunks[1].sequence).toBe(1);
    expect(chunks[1].overlapMs).toBe(OVERLAP_MS);
    // Recorder 1 began one overlap-width before the first boundary.
    expect(chunks[1].startOffsetMs).toBe(CHUNK_MS - OVERLAP_MS);
  });

  it("keeps emitting chunks in order over a long recording", () => {
    const chunks = [];
    const recorder = build((c) => chunks.push(c));
    recorder.start();

    vi.advanceTimersByTime(CHUNK_MS * 5);

    expect(chunks.map((c) => c.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  it("gives each chunk a complete blob of its own, not a stream fragment", () => {
    // The bug this design exists to avoid: only chunk 0 being decodable.
    const chunks = [];
    const recorder = build((c) => chunks.push(c));
    recorder.start();
    vi.advanceTimersByTime(CHUNK_MS * 3);

    for (const chunk of chunks) {
      expect(chunk.blob.size).toBeGreaterThan(0);
      expect(chunk.blob.type).toContain("audio/");
    }
  });

  it("flushes the in-progress chunk when stopped early", () => {
    const chunks = [];
    const recorder = build((c) => chunks.push(c));
    recorder.start();

    // Stop mid-chunk; the partial recording must not be discarded.
    vi.advanceTimersByTime(CHUNK_MS / 2);
    recorder.stop();

    expect(chunks).toHaveLength(1);
    expect(chunks[0].sequence).toBe(0);
  });

  it("flushes both recorders when stopped during the overlap window", () => {
    const chunks = [];
    const recorder = build((c) => chunks.push(c));
    recorder.start();

    vi.advanceTimersByTime(CHUNK_MS - OVERLAP_MS + 10);
    recorder.stop();

    expect(chunks.map((c) => c.sequence).sort()).toEqual([0, 1]);
  });

  it("schedules nothing further after being stopped", () => {
    const chunks = [];
    const recorder = build((c) => chunks.push(c));
    recorder.start();
    vi.advanceTimersByTime(CHUNK_MS);
    recorder.stop();

    const countAfterStop = chunks.length;
    vi.advanceTimersByTime(CHUNK_MS * 3);

    expect(chunks).toHaveLength(countAfterStop);
    expect(recorder.isRecording).toBe(false);
  });

  it("ignores a second start()", () => {
    const recorder = build(() => {});
    recorder.start();
    recorder.start();

    expect(FakeRecorder.instances).toHaveLength(1);
  });

  it("ignores stop() when not recording", () => {
    const recorder = build(() => {});
    expect(() => recorder.stop()).not.toThrow();
  });

  it("reports a recorder that fails to construct instead of throwing", () => {
    const errors = [];
    const recorder = createChunkedRecorder({
      stream: {},
      onChunk: () => {},
      onError: (err) => errors.push(err),
      createRecorder: () => {
        throw new Error("codec not supported");
      },
    });

    recorder.start();
    expect(errors[0].message).toMatch(/Could not start recording/);
  });

  it("drops an empty chunk rather than uploading silence-sized garbage", () => {
    const chunks = [];
    const recorder = createChunkedRecorder({
      stream: {},
      chunkMs: CHUNK_MS,
      overlapMs: OVERLAP_MS,
      onChunk: (c) => chunks.push(c),
      createRecorder: () => {
        const rec = new FakeRecorder();
        rec.stop = function stop() {
          this.state = "inactive";
          // No ondataavailable: the recorder produced nothing.
          this.onstop?.();
        };
        return rec;
      },
    });

    recorder.start();
    vi.advanceTimersByTime(CHUNK_MS);

    expect(chunks).toHaveLength(0);
  });
});
