/**
 * Meeting list and detail endpoints, which the UI screens read from.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { migrate } from "../src/services/migrate.js";
import {
  closeClient,
  createMeeting,
  insertTranscriptLine,
  updateMeetingStatus,
  upsertMinutes,
  getClient,
} from "../src/services/db.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";

let app;

beforeAll(async () => {
  await migrate({ logger: { info: () => {} } });
  app = createApp({ provider: createFakeProvider() });
});

afterAll(() => {
  closeClient();
});

beforeEach(async () => {
  // Isolate each test from the shared in-memory database.
  await getClient().executeMultiple(`
    DELETE FROM minutes;
    DELETE FROM transcript_lines;
    DELETE FROM meetings;
  `);
});

describe("GET /api/meetings", () => {
  it("returns an empty list rather than 404 when nothing is recorded", async () => {
    const res = await request(app).get("/api/meetings");

    expect(res.status).toBe(200);
    expect(res.body.meetings).toEqual([]);
  });

  it("lists meetings newest first", async () => {
    await createMeeting({ id: randomUUID(), title: "Older", startedAt: "2026-08-01T09:00:00Z" });
    await createMeeting({ id: randomUUID(), title: "Newer", startedAt: "2026-08-27T09:00:00Z" });

    const res = await request(app).get("/api/meetings");

    expect(res.body.meetings.map((m) => m.title)).toEqual(["Newer", "Older"]);
  });

  it("uses camelCase field names for the client", async () => {
    const id = randomUUID();
    await createMeeting({ id, title: "Sync" });
    await updateMeetingStatus(id, "done", { endedAt: "2026-08-27T09:15:00Z" });

    const res = await request(app).get("/api/meetings");
    const meeting = res.body.meetings[0];

    expect(meeting).toMatchObject({ title: "Sync", status: "done" });
    expect(meeting.startedAt).toBeTruthy();
    expect(meeting.endedAt).toBe("2026-08-27T09:15:00Z");
    expect(meeting.started_at).toBeUndefined();
  });
});

describe("GET /api/meetings/:id", () => {
  it("returns the meeting, its transcript and its minutes together", async () => {
    const id = randomUUID();
    await createMeeting({ id, title: "Billing sync" });
    await insertTranscriptLine({
      meetingId: id,
      speakerLabel: "Speaker 1",
      text: "we should ship on Friday",
      sequence: 0,
    });
    await upsertMinutes(id, {
      decisions: ["Ship on Friday"],
      action_items: [{ task: "Migrate", owner: "Priya", due: "Thursday" }],
      open_questions: [],
    });
    await updateMeetingStatus(id, "done");

    const res = await request(app).get(`/api/meetings/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.meeting.title).toBe("Billing sync");
    expect(res.body.transcript).toHaveLength(1);
    expect(res.body.transcript[0].speakerLabel).toBe("Speaker 1");
    expect(res.body.minutes.decisions).toEqual(["Ship on Friday"]);
    expect(res.body.minutes.action_items[0].owner).toBe("Priya");
  });

  it("returns null minutes rather than failing when none exist", async () => {
    const id = randomUUID();
    await createMeeting({ id, title: "No minutes yet" });

    const res = await request(app).get(`/api/meetings/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.minutes).toBeNull();
    expect(res.body.transcript).toEqual([]);
  });

  it("returns the transcript even when the meeting failed", async () => {
    // The transcript is the valuable artefact; a failed summary must not hide it.
    const id = randomUUID();
    await createMeeting({ id, title: "Failed one" });
    await insertTranscriptLine({
      meetingId: id,
      speakerLabel: "Speaker 1",
      text: "this was still captured",
      sequence: 0,
    });
    await updateMeetingStatus(id, "failed");

    const res = await request(app).get(`/api/meetings/${id}`);

    expect(res.body.meeting.status).toBe("failed");
    expect(res.body.transcript[0].text).toBe("this was still captured");
  });

  it("orders transcript lines by sequence", async () => {
    const id = randomUUID();
    await createMeeting({ id, title: "Ordering" });
    for (const sequence of [2, 0, 1]) {
      await insertTranscriptLine({
        meetingId: id,
        speakerLabel: "Speaker 1",
        text: `line ${sequence}`,
        sequence,
      });
    }

    const res = await request(app).get(`/api/meetings/${id}`);
    expect(res.body.transcript.map((l) => l.text)).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("404s for a meeting that does not exist", async () => {
    const res = await request(app).get(`/api/meetings/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("400s on a non-UUID id", async () => {
    const res = await request(app).get("/api/meetings/not-a-uuid");
    expect(res.status).toBe(400);
  });
});
