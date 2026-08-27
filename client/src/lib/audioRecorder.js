/**
 * Chunked microphone recording.
 *
 * WHY THIS IS NOT JUST MediaRecorder.start(timeslice):
 * In timeslice mode only the FIRST blob carries the container header, so every
 * later blob is not independently decodable. Whisper needs a complete audio
 * file per request, so a naive timeslice implementation transcribes chunk 1 and
 * then fails on every chunk after it.
 *
 * Instead each chunk is its own complete recording: a recorder is stopped and a
 * fresh one started every `chunkMs`. To avoid slicing a word in half at the
 * boundary, the next recorder starts `overlapMs` BEFORE the current one stops,
 * so two recorders briefly run against the same stream. The duplicated words
 * that produces are trimmed server-side.
 *
 * Timeline (chunkMs = 20s, overlapMs = 1s):
 *
 *   R0  [0s ─────────────── 20s]
 *   R1                 [19s ─────────────── 40s]
 *   R2                                 [39s ─────────────── 60s]
 */

/** Container formats Whisper accepts, best first. */
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

/**
 * @param {typeof MediaRecorder} [recorderClass]
 * @returns {string} A supported mime type, or "" to let the browser choose.
 */
export function pickMimeType(recorderClass = globalThis.MediaRecorder) {
  if (!recorderClass?.isTypeSupported) return "";
  return PREFERRED_MIME_TYPES.find((type) => recorderClass.isTypeSupported(type)) ?? "";
}

/**
 * @typedef {Object} AudioChunk
 * @property {Blob} blob
 * @property {number} sequence
 * @property {number} startOffsetMs  Milliseconds from the start of recording
 * @property {number} overlapMs      Overlap with the previous chunk
 * @property {string} mimeType
 */

/**
 * @param {Object} options
 * @param {MediaStream} options.stream
 * @param {(chunk: AudioChunk) => void} options.onChunk
 * @param {(error: Error) => void} [options.onError]
 * @param {number} [options.chunkMs]   Default 20000. Groq's free Whisper tier is
 *                                     ~30 req/min, so ~20s keeps one meeting at
 *                                     ~3 req/min with plenty of headroom.
 * @param {number} [options.overlapMs] Default 1000.
 * @param {(stream: MediaStream, options: object) => MediaRecorder} [options.createRecorder]
 *   Injectable for tests.
 * @param {() => number} [options.now] Injectable clock for tests.
 */
export function createChunkedRecorder({
  stream,
  onChunk,
  onError,
  chunkMs = 20_000,
  overlapMs = 1_000,
  createRecorder,
  now = () => Date.now(),
}) {
  if (overlapMs >= chunkMs) {
    throw new Error("overlapMs must be smaller than chunkMs");
  }

  const mimeType = pickMimeType();
  const makeRecorder =
    createRecorder ??
    ((mediaStream, opts) => new MediaRecorder(mediaStream, opts));

  /** @type {Map<number, MediaRecorder>} */
  const active = new Map();
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();

  let startedAt = 0;
  let running = false;
  let nextIndex = 0;

  function schedule(fn, delayMs) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (running) fn();
    }, Math.max(0, delayMs));
    timers.add(timer);
    return timer;
  }

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  /** Starts recorder `index`, stamping its true offset from the wall clock so
   *  accumulated timer drift cannot corrupt chunk timings. */
  function launch(index) {
    const startOffsetMs = index === 0 ? 0 : Math.max(0, now() - startedAt);

    let recorder;
    try {
      recorder = makeRecorder(stream, mimeType ? { mimeType } : {});
    } catch (err) {
      onError?.(new Error(`Could not start recording: ${err.message}`));
      return;
    }

    /** @type {Blob[]} */
    const parts = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) parts.push(event.data);
    };

    recorder.onerror = (event) => {
      onError?.(new Error(`Recording error: ${event?.error?.message ?? "unknown"}`));
    };

    recorder.onstop = () => {
      active.delete(index);
      if (parts.length === 0) return;

      // One complete, independently decodable file per chunk.
      const blob = new Blob(parts, { type: mimeType || parts[0].type });
      if (blob.size === 0) return;

      onChunk({
        blob,
        sequence: index,
        startOffsetMs,
        overlapMs: index === 0 ? 0 : overlapMs,
        mimeType: blob.type,
      });
    };

    active.set(index, recorder);
    recorder.start();
  }

  /** Stops recorder `index` if it is still running. */
  function finish(index) {
    const recorder = active.get(index);
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  /**
   * Called at (k * chunkMs) - overlapMs: start recorder k, then stop k-1 once
   * the overlap window has elapsed, then schedule the next rotation.
   * @param {number} k
   */
  function rotate(k) {
    launch(k);
    nextIndex = k + 1;

    schedule(() => finish(k - 1), overlapMs);
    schedule(() => rotate(k + 1), chunkMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      startedAt = now();
      nextIndex = 1;

      launch(0);
      schedule(() => rotate(1), chunkMs - overlapMs);
    },

    /** Stops everything and flushes whatever the active recorders hold. */
    stop() {
      if (!running) return;
      running = false;
      clearTimers();

      for (const index of [...active.keys()]) finish(index);
    },

    get isRecording() {
      return running;
    },

    /** Exposed for assertions and diagnostics. */
    get state() {
      return { running, nextIndex, activeRecorders: active.size, mimeType };
    },
  };
}
