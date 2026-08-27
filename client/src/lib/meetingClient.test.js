/**
 * Meeting client: reconnection, offline buffering, and resume.
 *
 * A dropped socket on a free host is expected, not exceptional, so these paths
 * are the ones worth testing. A fake socket stands in for the real one.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMeetingClient } from "./meetingClient.js";

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Test control: complete the handshake. */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Test control: deliver a server message. */
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Test control: the connection drops without us closing it. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }

  get last() {
    return this.sent[this.sent.length - 1];
  }
}

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

/** Builds a client with a manual reconnect scheduler. */
function build() {
  const events = [];
  const states = [];
  const pendingTimers = [];

  const client = createMeetingClient({
    url: "ws://test/ws",
    onEvent: (event) => events.push(event),
    onConnectionChange: (state) => states.push(state),
    createSocket: (url) => new FakeSocket(url),
    setTimeoutFn: (fn) => pendingTimers.push(fn),
  });

  return {
    client,
    events,
    states,
    /** Fires every scheduled reconnect. */
    runTimers() {
      const timers = pendingTimers.splice(0);
      for (const fn of timers) fn();
    },
    get pendingTimerCount() {
      return pendingTimers.length;
    },
    get socket() {
      return FakeSocket.instances[FakeSocket.instances.length - 1];
    },
  };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

describe("connection", () => {
  it("reports connecting then open", () => {
    const h = build();
    h.client.connect();
    expect(h.states).toContain("connecting");

    h.socket.open();
    expect(h.states).toContain("open");
  });

  it("sends start_recording once open", () => {
    const h = build();
    h.client.connect();
    h.socket.open();

    h.client.startRecording("Board sync");
    expect(h.socket.last).toEqual({ type: "start_recording", title: "Board sync" });
  });

  it("tracks the meeting id the server assigns", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });

    expect(h.client.state.meetingId).toBe(MEETING_ID);
    expect(h.client.state.recording).toBe(true);
  });
});

describe("offline buffering", () => {
  it("buffers a chunk sent before the socket is open, then flushes it", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });

    h.socket.drop();

    h.client.sendChunk({ base64: "AAAA", sequence: 0 });
    expect(h.client.state.buffered).toBe(1);

    h.runTimers(); // reconnect
    h.socket.open();

    const chunks = h.socket.sent.filter((m) => m.type === "audio_chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sequence).toBe(0);
    expect(h.client.state.buffered).toBe(0);
  });

  it("preserves chunk order through an outage", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });
    h.socket.drop();

    for (let i = 0; i < 4; i += 1) h.client.sendChunk({ base64: "AAAA", sequence: i });

    h.runTimers();
    h.socket.open();

    const sequences = h.socket.sent
      .filter((m) => m.type === "audio_chunk")
      .map((m) => m.sequence);
    expect(sequences).toEqual([0, 1, 2, 3]);
  });

  it("caps the buffer and warns the user rather than growing without bound", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });
    h.socket.drop();

    for (let i = 0; i < 40; i += 1) h.client.sendChunk({ base64: "AAAA", sequence: i });

    expect(h.client.state.buffered).toBeLessThanOrEqual(30);
    // The user is told audio was dropped — never silently discarded.
    expect(h.events.some((e) => e.type === "transcription_error")).toBe(true);
  });

  it("ignores a chunk sent before any meeting exists", () => {
    const h = build();
    h.client.connect();
    h.socket.open();

    h.client.sendChunk({ base64: "AAAA", sequence: 0 });
    expect(h.socket.sent.filter((m) => m.type === "audio_chunk")).toHaveLength(0);
  });
});

describe("reconnection", () => {
  it("reconnects automatically after an unexpected drop", () => {
    const h = build();
    h.client.connect();
    h.socket.open();

    const before = FakeSocket.instances.length;
    h.socket.drop();
    expect(h.states).toContain("reconnecting");

    h.runTimers();
    expect(FakeSocket.instances.length).toBe(before + 1);
  });

  it("asks the server to replay what it missed, from the last sequence seen", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });
    h.socket.receive({ type: "transcript_line", sequence: 0, text: "one", speakerLabel: "Speaker 1" });
    h.socket.receive({ type: "transcript_line", sequence: 1, text: "two", speakerLabel: "Speaker 1" });

    h.socket.drop();
    h.runTimers();
    h.socket.open();

    expect(h.socket.sent[0]).toEqual({
      type: "resume_recording",
      meetingId: MEETING_ID,
      lastSequence: 1,
    });
  });

  it("does not resume when no meeting is in progress", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.drop();
    h.runTimers();
    h.socket.open();

    expect(h.socket.sent.some((m) => m.type === "resume_recording")).toBe(false);
  });

  it("emits replayed lines as ordinary transcript lines", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });
    h.socket.receive({
      type: "resumed",
      meetingId: MEETING_ID,
      lines: [
        { sequence: 0, text: "missed one", speakerLabel: "Speaker 1", timestamp: "t" },
        { sequence: 1, text: "missed two", speakerLabel: "Speaker 1", timestamp: "t" },
      ],
    });

    const lines = h.events.filter((e) => e.type === "transcript_line");
    expect(lines.map((l) => l.text)).toEqual(["missed one", "missed two"]);
    expect(h.client.state.lastSequence).toBe(1);
  });

  it("ignores a line it has already seen, so a replay cannot duplicate the transcript", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });
    h.socket.receive({ type: "transcript_line", sequence: 0, text: "one" });
    h.socket.receive({ type: "transcript_line", sequence: 0, text: "one again" });

    expect(h.events.filter((e) => e.type === "transcript_line")).toHaveLength(1);
  });

  it("stops reconnecting once deliberately disconnected", () => {
    const h = build();
    h.client.connect();
    h.socket.open();

    h.client.disconnect();
    expect(h.states).toContain("closed");

    const before = FakeSocket.instances.length;
    h.runTimers();
    expect(FakeSocket.instances.length).toBe(before);
  });

  it("survives a socket constructor that throws", () => {
    const events = [];
    const timers = [];
    const client = createMeetingClient({
      url: "ws://test/ws",
      onEvent: (e) => events.push(e),
      createSocket: () => {
        throw new Error("blocked");
      },
      setTimeoutFn: (fn) => timers.push(fn),
    });

    expect(() => client.connect()).not.toThrow();
    expect(timers.length).toBeGreaterThan(0);
  });

  it("ignores an unparseable frame instead of crashing", () => {
    const h = build();
    h.client.connect();
    h.socket.open();

    expect(() => h.socket.onmessage({ data: "not json" })).not.toThrow();
  });
});

describe("stop", () => {
  it("sends stop_recording for the active meeting", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });

    h.client.stopRecording();
    expect(h.socket.last).toEqual({ type: "stop_recording", meetingId: MEETING_ID });
  });

  it("clears the recording flag when the server confirms", () => {
    const h = build();
    h.client.connect();
    h.socket.open();
    h.socket.receive({ type: "recording_started", meetingId: MEETING_ID });
    h.socket.receive({ type: "recording_stopped", meetingId: MEETING_ID });

    expect(h.client.state.recording).toBe(false);
  });
});
