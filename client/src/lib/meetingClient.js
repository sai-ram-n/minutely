/**
 * Meeting WebSocket client.
 *
 * Deliberately plain JavaScript rather than a React hook, so the reconnection
 * and buffering behaviour can be tested against a fake socket. The hook in
 * hooks/useMeetingSocket.js is a thin wrapper over this.
 *
 * The free backend restarts and sleeps, so a dropped socket mid-meeting is an
 * expected event, not an exceptional one. Two things protect the transcript:
 *   1. chunks recorded while disconnected are buffered and flushed on reconnect
 *   2. on reconnect the client asks the server to replay lines it missed
 */

/** Reconnect backoff: 0.5s, 1s, 2s, 4s, 8s, then every 10s. */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const MAX_RECONNECT_DELAY_MS = 10_000;

/** Cap the offline buffer so a long outage cannot exhaust browser memory. */
const MAX_BUFFERED_CHUNKS = 30;

/**
 * @param {Blob} blob
 * @returns {Promise<string>} base64, without the data: URL prefix
 */
export async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Chunked to avoid blowing the argument limit on large buffers.
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * @param {Object} options
 * @param {string} options.url
 * @param {(event: object) => void} options.onEvent
 * @param {(state: string) => void} [options.onConnectionChange]
 * @param {(url: string) => WebSocket} [options.createSocket] Injectable for tests.
 * @param {(fn: Function, ms: number) => any} [options.setTimeoutFn]
 */
export function createMeetingClient({
  url,
  onEvent,
  onConnectionChange,
  createSocket = (target) => new WebSocket(target),
  setTimeoutFn = setTimeout,
}) {
  /** @type {WebSocket | null} */
  let socket = null;
  let connectionState = "idle";
  let attempts = 0;
  let closedByUs = false;

  /** Messages queued while the socket was not open. */
  let outbox = [];

  let meetingId = null;
  let lastSequence = -1;
  let recording = false;

  function setState(next) {
    if (connectionState === next) return;
    connectionState = next;
    onConnectionChange?.(next);
  }

  function flushOutbox() {
    if (!socket || socket.readyState !== 1) return;
    const pending = outbox;
    outbox = [];
    for (const message of pending) socket.send(JSON.stringify(message));
  }

  /** Sends now if open, otherwise buffers for the next successful connection. */
  function send(message) {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(message));
      return;
    }

    if (message.type === "audio_chunk" && outbox.length >= MAX_BUFFERED_CHUNKS) {
      // Drop the oldest rather than the newest: recent audio is more useful,
      // and the user is told either way.
      outbox.shift();
      onEvent({
        type: "transcription_error",
        message: "Offline for a while — some earlier audio was dropped.",
      });
    }
    outbox.push(message);
  }

  function scheduleReconnect() {
    if (closedByUs) return;

    const delay =
      RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)] ??
      MAX_RECONNECT_DELAY_MS;
    attempts += 1;

    setState("reconnecting");
    setTimeoutFn(connect, delay);
  }

  function connect() {
    if (closedByUs) return;
    setState(attempts === 0 ? "connecting" : "reconnecting");

    try {
      socket = createSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      attempts = 0;
      setState("open");

      // Mid-meeting reconnect: ask for anything missed, then flush what was
      // recorded while the socket was down.
      if (recording && meetingId) {
        socket.send(JSON.stringify({ type: "resume_recording", meetingId, lastSequence }));
      }
      flushOutbox();
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return; // A frame we cannot parse is not worth crashing the UI over.
      }
      handleServerMessage(message);
    };

    socket.onclose = () => {
      socket = null;
      if (closedByUs) {
        setState("closed");
        return;
      }
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows; reconnection is handled there.
    };
  }

  function handleServerMessage(message) {
    switch (message.type) {
      case "recording_started":
        meetingId = message.meetingId;
        recording = true;
        lastSequence = -1;
        break;

      case "transcript_line":
        if (typeof message.sequence === "number") {
          // Replayed lines can arrive twice after a reconnect.
          if (message.sequence <= lastSequence) return;
          lastSequence = message.sequence;
        }
        break;

      case "resumed":
        for (const line of message.lines ?? []) {
          if (line.sequence > lastSequence) lastSequence = line.sequence;
          onEvent({ type: "transcript_line", ...line });
        }
        return;

      case "recording_stopped":
      case "mom_ready":
      case "mom_failed":
        recording = false;
        break;

      default:
        break;
    }

    onEvent(message);
  }

  return {
    connect() {
      closedByUs = false;
      attempts = 0;
      connect();
    },

    /** @param {string} title */
    startRecording(title) {
      send({ type: "start_recording", title });
    },

    /** @param {{ base64: string, sequence: number, mimeType?: string, startOffsetMs?: number, overlapMs?: number }} chunk */
    sendChunk({ base64, sequence, mimeType, startOffsetMs, overlapMs }) {
      if (!meetingId) return;
      send({
        type: "audio_chunk",
        meetingId,
        data: base64,
        sequence,
        ...(mimeType ? { mimeType } : {}),
        ...(startOffsetMs !== undefined ? { startOffsetMs } : {}),
        ...(overlapMs !== undefined ? { overlapMs } : {}),
      });
    },

    stopRecording() {
      if (!meetingId) return;
      send({ type: "stop_recording", meetingId });
    },

    disconnect() {
      closedByUs = true;
      outbox = [];
      if (socket) socket.close();
      socket = null;
      setState("closed");
    },

    get state() {
      return { connectionState, meetingId, lastSequence, recording, buffered: outbox.length };
    },
  };
}
