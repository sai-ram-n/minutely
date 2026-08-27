/**
 * Participant count.
 *
 * Silence-gap detection can tell that the speaker changed but never who is
 * talking, so labels cycle through a fixed set. Testing a real four-person
 * recording with that set pinned to two gave two different people the same
 * label — actively misleading, not merely incomplete. The count is now declared
 * by the user before recording starts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/services/migrate.js";
import { closeClient, getMeeting, getTranscriptLines } from "../src/services/db.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";
import { startTestServer, connect } from "./helpers/socketHarness.js";
import { MAX_SPEAKERS } from "../src/ws/messages.js";

const AUDIO = Buffer.from("pretend-this-is-opus").toString("base64");

let server;

beforeAll(async () => {
  await migrate({ logger: { info: () => {} } });
});

afterAll(async () => {
  if (server) await server.close();
  closeClient();
});

/** Four utterances separated by pauses past the 1.5s threshold. */
const FOUR_TURNS = {
  name: "four-turn-fake",
  transcribe: async () => ({
    text: "one two three four",
    segments: [
      { start: 0, end: 1, text: "first person speaking" },
      { start: 3, end: 4, text: "second person speaking" },
      { start: 6, end: 7, text: "third person speaking" },
      { start: 9, end: 10, text: "fourth person speaking" },
    ],
  }),
  summarize: async () => ({ decisions: [], action_items: [], open_questions: [] }),
};

beforeEach(async () => {
  if (server) await server.close();
  server = await startTestServer({ provider: FOUR_TURNS });
});

async function record(speakerCount) {
  const client = await connect(server.url);
  client.send({ type: "start_recording", title: "Four people", ...(speakerCount !== undefined ? { speakerCount } : {}) });
  const started = await client.waitFor("recording_started");

  client.send({ type: "audio_chunk", meetingId: started.meetingId, data: AUDIO, sequence: 0 });
  await new Promise((r) => setTimeout(r, 350));

  const lines = await getTranscriptLines(started.meetingId);
  await client.close();
  return { meetingId: started.meetingId, lines };
}

describe("declaring the participant count", () => {
  it("labels four speakers distinctly when four are declared", async () => {
    const { lines } = await record(4);

    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.speaker_label)).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 3",
      "Speaker 4",
    ]);
  });

  it("reproduces the misleading behaviour when only two are declared", async () => {
    // This is exactly what the real four-person recording did: the third
    // person is given the first person's label.
    const { lines } = await record(2);

    expect(lines.map((l) => l.speaker_label)).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 1",
      "Speaker 2",
    ]);
  });

  it("defaults to two when the client does not say", async () => {
    const { meetingId } = await record(undefined);
    expect((await getMeeting(meetingId)).speaker_count).toBe(2);
  });

  it("persists the count on the meeting", async () => {
    const { meetingId } = await record(4);
    expect((await getMeeting(meetingId)).speaker_count).toBe(4);
  });

  it("supports a one-person recording, where labels never advance", async () => {
    const { lines } = await record(1);
    expect(new Set(lines.map((l) => l.speaker_label))).toEqual(new Set(["Speaker 1"]));
  });

  it("accepts the documented maximum", async () => {
    const { meetingId } = await record(MAX_SPEAKERS);
    expect((await getMeeting(meetingId)).speaker_count).toBe(MAX_SPEAKERS);
  });

  it("rejects a count above the maximum rather than clamping silently", async () => {
    const client = await connect(server.url);
    client.send({ type: "start_recording", title: "Too many", speakerCount: 99 });

    const error = await client.waitFor("error");
    expect(error.message).toMatch(/speakerCount/);
    await client.close();
  });

  it("rejects zero and negative counts", async () => {
    for (const speakerCount of [0, -1]) {
      const client = await connect(server.url);
      client.send({ type: "start_recording", title: "Bad", speakerCount });
      await expect(client.waitFor("error")).resolves.toBeTruthy();
      await client.close();
    }
  });
});

describe("the API exposes the count", () => {
  it("includes speakerCount on the meeting detail", async () => {
    const { meetingId } = await record(4);
    const app = createApp({ provider: createFakeProvider() });

    const res = await request(app).get(`/api/meetings/${meetingId}`);
    expect(res.body.meeting.speakerCount).toBe(4);
  });

  it("includes speakerCount in the meeting list", async () => {
    await record(3);
    const app = createApp({ provider: createFakeProvider() });

    const res = await request(app).get("/api/meetings");
    expect(res.body.meetings[0].speakerCount).toBeGreaterThan(0);
  });
});
