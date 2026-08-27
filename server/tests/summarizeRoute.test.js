/**
 * The retry endpoint.
 *
 * The spec requires a failed meeting to surface a retry affordance rather than
 * becoming an invisible dead end. These cover the statuses the UI keys off.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { migrate } from "../src/services/migrate.js";
import {
  closeClient,
  createMeeting,
  getMeeting,
  insertTranscriptLine,
  updateMeetingStatus,
} from "../src/services/db.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";
import { HttpError } from "../src/ai/retry.js";

let meetingId;

beforeAll(async () => {
  await migrate({ logger: { info: () => {} } });
});

afterAll(() => {
  closeClient();
});

/** A meeting that failed summarization and now needs retrying. */
beforeEach(async () => {
  meetingId = randomUUID();
  await createMeeting({ id: meetingId, title: "Retry test" });
  await insertTranscriptLine({
    meetingId,
    speakerLabel: "Speaker 1",
    text: "we should ship on Friday",
    sequence: 0,
  });
  await updateMeetingStatus(meetingId, "failed", { endedAt: new Date().toISOString() });
});

describe("POST /api/meetings/:id/summarize", () => {
  it("regenerates minutes and moves the meeting to done", async () => {
    const app = createApp({ provider: createFakeProvider() });
    const res = await request(app).post(`/api/meetings/${meetingId}/summarize`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.minutes.decisions).toEqual(["Adopt the fake provider for tests"]);
    expect((await getMeeting(meetingId)).status).toBe("done");
  });

  it("recovers a meeting that was left in processing", async () => {
    await updateMeetingStatus(meetingId, "processing");

    const app = createApp({ provider: createFakeProvider() });
    const res = await request(app).post(`/api/meetings/${meetingId}/summarize`);

    expect(res.status).toBe(200);
    expect((await getMeeting(meetingId)).status).toBe("done");
  });

  it("refuses while the meeting is still recording", async () => {
    await updateMeetingStatus(meetingId, "recording");

    const app = createApp({ provider: createFakeProvider() });
    const res = await request(app).post(`/api/meetings/${meetingId}/summarize`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still recording/);
  });

  it("reports rate limiting as retryable", async () => {
    const app = createApp({
      provider: createFakeProvider({ summarizeError: new HttpError(429, "rate limited") }),
    });
    const res = await request(app).post(`/api/meetings/${meetingId}/summarize`);

    expect(res.status).toBe(429);
    expect(res.body.retryable).toBe(true);
    expect((await getMeeting(meetingId)).status).toBe("failed");
  });

  it("reports a provider failure as retryable without leaking internals", async () => {
    const app = createApp({
      provider: createFakeProvider({ summarizeError: new HttpError(503, "upstream exploded") }),
    });
    const res = await request(app).post(`/api/meetings/${meetingId}/summarize`);

    expect(res.status).toBe(502);
    expect(res.body.retryable).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("upstream exploded");
  });

  it("reports an empty transcript as NOT retryable", async () => {
    const silent = randomUUID();
    await createMeeting({ id: silent, title: "Silent" });
    await updateMeetingStatus(silent, "failed");

    const app = createApp({ provider: createFakeProvider() });
    const res = await request(app).post(`/api/meetings/${silent}/summarize`);

    expect(res.status).toBe(422);
    expect(res.body.retryable).toBe(false);
    expect(res.body.error).toMatch(/nothing to summarize/);
  });

  it("404s for a meeting that does not exist", async () => {
    const app = createApp({ provider: createFakeProvider() });
    const res = await request(app).post(`/api/meetings/${randomUUID()}/summarize`);

    expect(res.status).toBe(404);
  });

  it("400s on a non-UUID id", async () => {
    const app = createApp({ provider: createFakeProvider() });
    const res = await request(app).post("/api/meetings/nope/summarize");

    expect(res.status).toBe(400);
  });
});

describe("GET /api/meetings/:id/minutes", () => {
  it("returns stored minutes with the meeting status", async () => {
    const app = createApp({ provider: createFakeProvider() });
    await request(app).post(`/api/meetings/${meetingId}/summarize`);

    const res = await request(app).get(`/api/meetings/${meetingId}/minutes`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.minutes.action_items[0].task).toBeTruthy();
  });

  it("404s when minutes have not been generated yet", async () => {
    const app = createApp({ provider: createFakeProvider() });
    const res = await request(app).get(`/api/meetings/${meetingId}/minutes`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No minutes/);
  });

  it("404s for a meeting that does not exist", async () => {
    const app = createApp({ provider: createFakeProvider() });
    const res = await request(app).get(`/api/meetings/${randomUUID()}/minutes`);

    expect(res.status).toBe(404);
  });
});
