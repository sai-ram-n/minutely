/**
 * Meeting WebSocket behaviour, against a real server and a fake AiProvider.
 *
 * The emphasis is on the failure paths: the spec is explicit that a malformed
 * payload must not crash the server and that a failed chunk must never be
 * silently dropped.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { migrate } from "../src/services/migrate.js";
import { closeClient, getMeeting, getTranscriptLines } from "../src/services/db.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";
import { startTestServer, connect, expectUpgradeRejected } from "./helpers/socketHarness.js";
import { HttpError } from "../src/ai/retry.js";

/** Any valid base64 stands in for audio; the provider is faked. */
const AUDIO = Buffer.from("pretend-this-is-opus").toString("base64");
const UUID = "00000000-0000-4000-8000-000000000000";

let server;
let provider;

beforeAll(async () => {
  await migrate({ logger: { info: () => {} } });
});

afterAll(() => {
  closeClient();
});

beforeEach(async () => {
  if (server) await server.close();
  provider = createFakeProvider();
  server = await startTestServer({ provider });
});

afterAll(async () => {
  if (server) await server.close();
});

/** Starts a recording and returns the client plus the new meeting id. */
async function startRecording(title = "Test meeting") {
  const client = await connect(server.url);
  client.send({ type: "start_recording", title });
  const started = await client.waitFor("recording_started");
  return { client, meetingId: started.meetingId };
}

describe("malformed input", () => {
  it("rejects non-JSON without dropping the connection", async () => {
    const client = await connect(server.url);
    client.send("this is not json");

    const error = await client.waitFor("error");
    expect(error.message).toMatch(/not valid JSON/);
    expect(client.socket.readyState).toBe(client.socket.OPEN);

    await client.close();
  });

  it("rejects an unknown message type by name", async () => {
    const client = await connect(server.url);
    client.send({ type: "definitely_not_a_real_type" });

    const error = await client.waitFor("error");
    expect(error.message).toMatch(/unknown message type/);

    await client.close();
  });

  it("rejects a JSON array rather than an object", async () => {
    const client = await connect(server.url);
    client.send([1, 2, 3]);

    const error = await client.waitFor("error");
    expect(error.message).toMatch(/must be a JSON object/);

    await client.close();
  });

  it("rejects an audio_chunk whose data is not base64", async () => {
    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: "!!! not base64 !!!", sequence: 0 });

    const error = await client.waitFor("error");
    expect(error.message).toMatch(/base64/);

    await client.close();
  });

  it("rejects an audio_chunk with a non-UUID meetingId", async () => {
    const client = await connect(server.url);
    client.send({ type: "audio_chunk", meetingId: "nope", data: AUDIO, sequence: 0 });

    const error = await client.waitFor("error");
    expect(error.message).toMatch(/UUID/);

    await client.close();
  });

  it("rejects an audio_chunk with a negative sequence", async () => {
    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: -5 });

    await expect(client.waitFor("error")).resolves.toBeTruthy();
    await client.close();
  });

  it("stays alive and usable after a burst of malformed messages", async () => {
    const client = await connect(server.url);

    client.send("garbage");
    client.send({ type: "nonsense" });
    client.send([1, 2]);
    client.send({ type: "audio_chunk", meetingId: "bad", data: "@@@", sequence: 0 });

    // The server should still handle a legitimate message afterwards.
    client.send({ type: "start_recording", title: "Still working" });
    const started = await client.waitFor("recording_started");
    expect(started.meetingId).toMatch(/^[0-9a-f-]{36}$/);

    await client.close();
  });
});

describe("start_recording", () => {
  it("creates a meeting and returns its id", async () => {
    const { client, meetingId } = await startRecording("Board sync");

    const meeting = await getMeeting(meetingId);
    expect(meeting).toMatchObject({ title: "Board sync", status: "recording" });
    expect(meeting.started_at).toBeTruthy();

    await client.close();
  });

  it("defaults a missing title rather than storing an empty one", async () => {
    const client = await connect(server.url);
    client.send({ type: "start_recording" });

    const started = await client.waitFor("recording_started");
    const meeting = await getMeeting(started.meetingId);
    expect(meeting.title).toBe("Untitled meeting");

    await client.close();
  });

  it("rejects an over-long title", async () => {
    const client = await connect(server.url);
    client.send({ type: "start_recording", title: "x".repeat(500) });

    await expect(client.waitFor("error")).resolves.toBeTruthy();
    await client.close();
  });
});

describe("audio_chunk", () => {
  it("transcribes a chunk and returns a transcript line", async () => {
    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });

    const line = await client.waitFor("transcript_line");
    expect(line.text).toBe("This is a fake transcription.");
    expect(line.speakerLabel).toBe("Speaker 1");
    expect(line.sequence).toBe(0);
    expect(provider.transcribe).toHaveBeenCalledTimes(1);

    await client.close();
  });

  it("persists the line", async () => {
    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });
    await client.waitFor("transcript_line");

    const lines = await getTranscriptLines(meetingId);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("This is a fake transcription.");

    await client.close();
  });

  it("refuses audio for an unknown meeting", async () => {
    const client = await connect(server.url);
    client.send({ type: "audio_chunk", meetingId: UUID, data: AUDIO, sequence: 0 });

    const error = await client.waitFor("error");
    expect(error.message).toMatch(/Unknown meeting/);

    await client.close();
  });

  it("stores chunks in order even when transcription resolves out of order", async () => {
    // Second call resolves first — the queue must still preserve chunk order.
    const delays = [40, 0, 0];
    let call = 0;
    const ordered = {
      name: "ordered-fake",
      transcribe: async () => {
        const index = call++;
        await new Promise((r) => setTimeout(r, delays[index] ?? 0));
        return { text: `chunk ${index}` };
      },
      summarize: async () => ({ decisions: [], action_items: [], open_questions: [] }),
    };

    await server.close();
    server = await startTestServer({ provider: ordered });

    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 1 });
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 2 });

    await new Promise((r) => setTimeout(r, 400));

    const lines = await getTranscriptLines(meetingId);
    expect(lines.map((l) => l.text)).toEqual(["chunk 0", "chunk 1", "chunk 2"]);

    await client.close();
  });

  it("stores nothing when a chunk transcribes to silence", async () => {
    await server.close();
    server = await startTestServer({
      provider: createFakeProvider({ transcription: { text: "   " } }),
    });

    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });
    await new Promise((r) => setTimeout(r, 200));

    expect(await getTranscriptLines(meetingId)).toHaveLength(0);
    await client.close();
  });
});

describe("transcription failure", () => {
  it("tells the client instead of silently dropping the chunk", async () => {
    await server.close();
    server = await startTestServer({
      provider: createFakeProvider({ transcribeError: new Error("provider exploded") }),
    });

    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });

    const error = await client.waitFor("transcription_error");
    expect(error.message).toMatch(/Could not transcribe/);
    expect(error.sequence).toBe(0);

    await client.close();
  });

  it("names rate limiting specifically, and marks it retryable", async () => {
    await server.close();
    server = await startTestServer({
      provider: createFakeProvider({
        transcribeError: new HttpError(429, "rate limited"),
      }),
    });

    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });

    const error = await client.waitFor("transcription_error");
    expect(error.message).toMatch(/rate limited/i);
    expect(error.retryable).toBe(true);

    await client.close();
  });

  it("keeps accepting chunks after one fails", async () => {
    let calls = 0;
    const flaky = {
      name: "flaky",
      transcribe: async () => {
        calls += 1;
        if (calls === 1) throw new Error("first one fails");
        return { text: "recovered line" };
      },
      summarize: async () => ({ decisions: [], action_items: [], open_questions: [] }),
    };

    await server.close();
    server = await startTestServer({ provider: flaky });

    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });
    await client.waitFor("transcription_error");

    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 1 });
    const line = await client.waitFor("transcript_line");
    expect(line.text).toBe("recovered line");

    await client.close();
  });
});

describe("stop_recording", () => {
  it("ends the meeting and stamps ended_at", async () => {
    const { client, meetingId } = await startRecording();
    client.send({ type: "stop_recording", meetingId });

    await client.waitFor("recording_stopped");
    const meeting = await getMeeting(meetingId);
    expect(meeting.ended_at).toBeTruthy();
    expect(meeting.status).toBe("done");

    await client.close();
  });

  it("refuses further audio once stopped", async () => {
    const { client, meetingId } = await startRecording();
    client.send({ type: "stop_recording", meetingId });
    await client.waitFor("recording_stopped");

    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 9 });
    const error = await client.waitFor("error");
    expect(error.message).toMatch(/not accepting more audio/);

    await client.close();
  });

  it("waits for in-flight chunks so the tail of the meeting is not lost", async () => {
    const slow = {
      name: "slow",
      transcribe: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { text: "the final words" };
      },
      summarize: async () => ({ decisions: [], action_items: [], open_questions: [] }),
    };

    await server.close();
    server = await startTestServer({ provider: slow });

    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });
    client.send({ type: "stop_recording", meetingId });

    await client.waitFor("recording_stopped");
    expect(await getTranscriptLines(meetingId)).toHaveLength(1);

    await client.close();
  });

  it("marks the meeting failed and says so when summarization throws", async () => {
    await server.close();
    server = await startTestServer({
      provider,
      onFinalize: async () => {
        throw new Error("groq is down");
      },
    });

    const { client, meetingId } = await startRecording();
    client.send({ type: "stop_recording", meetingId });

    const failed = await client.waitFor("mom_failed");
    expect(failed.message).toMatch(/retry/i);
    expect((await getMeeting(meetingId)).status).toBe("failed");

    await client.close();
  });

  it("reports mom_ready when summarization succeeds", async () => {
    await server.close();
    server = await startTestServer({ provider, onFinalize: async () => {} });

    const { client, meetingId } = await startRecording();
    client.send({ type: "stop_recording", meetingId });

    await client.waitFor("processing");
    const ready = await client.waitFor("mom_ready");
    expect(ready.meetingId).toBe(meetingId);

    await client.close();
  });
});

describe("resume_recording", () => {
  it("replays only the lines the client missed", async () => {
    const { client, meetingId } = await startRecording();

    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });
    await client.waitFor("transcript_line");
    await client.close();

    // A fresh connection standing in for a reconnect after a dropped socket.
    const reconnected = await connect(server.url);
    reconnected.send({ type: "resume_recording", meetingId, lastSequence: -1 });

    const resumed = await reconnected.waitFor("resumed");
    expect(resumed.lines).toHaveLength(1);
    expect(resumed.lines[0].text).toBe("This is a fake transcription.");

    await reconnected.close();
  });

  it("replays nothing when the client is already up to date", async () => {
    const { client, meetingId } = await startRecording();
    client.send({ type: "audio_chunk", meetingId, data: AUDIO, sequence: 0 });
    await client.waitFor("transcript_line");

    client.send({ type: "resume_recording", meetingId, lastSequence: 0 });
    const resumed = await client.waitFor("resumed");
    expect(resumed.lines).toHaveLength(0);

    await client.close();
  });

  it("refuses to resume an unknown meeting", async () => {
    const client = await connect(server.url);
    client.send({ type: "resume_recording", meetingId: UUID, lastSequence: -1 });

    const error = await client.waitFor("error");
    expect(error.message).toMatch(/cannot resume/);

    await client.close();
  });
});

describe("upgrade security", () => {
  it("rejects a disallowed Origin at the handshake", async () => {
    const err = await expectUpgradeRejected(server.url, {
      headers: { Origin: "https://evil.example" },
    });
    expect(String(err.message)).toMatch(/403/);
  });

  it("accepts the configured frontend origin", async () => {
    const client = await connect(server.url, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(client.socket.readyState).toBe(client.socket.OPEN);
    await client.close();
  });
});
