/**
 * Sample meeting playback.
 *
 * Produces a MediaStream from a bundled audio file so the sample runs through
 * exactly the same path as a real recording — MediaRecorder, the stop/restart
 * chunking, the overlap, the upload. Nothing is faked past this point, so what
 * you watch is the real pipeline, not a scripted demo.
 *
 * Web Audio is used rather than an <audio> element's captureStream(), which is
 * still prefixed or missing in some browsers.
 */

/** Where the bundled sample lives, relative to the site root. */
export const SAMPLE_URL = "/sample/sample-meeting.webm";

export const SAMPLE_MEETING = {
  title: "Mercury programme press briefing (sample)",
  // A moderator, reporters and several astronauts — more than two voices, which
  // is the point: it shows what turn labels do and do not tell you.
  speakerCount: 4,
  approxSeconds: 100,
  attribution:
    "NASA, First Seven Astronauts Press Conference, 9 April 1959 — public domain",
};

/**
 * @typedef {Object} SamplePlayback
 * @property {MediaStream} stream
 * @property {Promise<void>} finished  Resolves when the audio runs out
 * @property {() => void} stop
 */

/**
 * Loads the sample and starts playing it into a MediaStream.
 *
 * @param {Object} [options]
 * @param {string} [options.url]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => AudioContext} [options.createContext]
 * @returns {Promise<SamplePlayback>}
 */
export async function playSampleMeeting(options = {}) {
  const url = options.url ?? SAMPLE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const createContext =
    options.createContext ??
    (() => new (globalThis.AudioContext ?? globalThis.webkitAudioContext)());

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Could not load the sample recording (${response.status}).`);
  }

  const encoded = await response.arrayBuffer();
  const context = createContext();

  // Autoplay policies can leave a context suspended until a gesture; the button
  // click is that gesture, but resume() explicitly rather than assuming.
  if (context.state === "suspended") await context.resume();

  let buffer;
  try {
    buffer = await context.decodeAudioData(encoded);
  } catch {
    await context.close?.();
    throw new Error("The sample recording could not be decoded by this browser.");
  }

  const source = context.createBufferSource();
  source.buffer = buffer;

  const destination = context.createMediaStreamDestination();
  source.connect(destination);

  let settled = false;
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });

  const cleanup = () => {
    if (settled) return;
    settled = true;
    try {
      source.disconnect();
    } catch {
      // Already disconnected.
    }
    context.close?.();
    resolveFinished();
  };

  source.onended = cleanup;
  source.start();

  return {
    stream: destination.stream,
    finished,
    stop() {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      cleanup();
    },
  };
}
