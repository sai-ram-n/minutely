/**
 * Speaker renaming.
 *
 * The spec requires renaming a speaker inline but defines no endpoint for it,
 * so this covers the route added to fill that gap.
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
  getTranscriptLines,
} from "../src/services/db.js";

let app;

beforeAll(async () => {
  await migrate({ logger: { info: () => {} } });
  app = createApp();
});

afterAll(() => {
  closeClient();
});

let meetingId;

/** A two-speaker transcript to rename within. */
beforeEach(async () => {
  meetingId = randomUUID();
  await createMeeting({ id: meetingId, title: "Rename test" });

  const lines = [
    ["Speaker 1", "we should ship on Friday", 0],
    ["Speaker 2", "I will run the migration", 1],
    ["Speaker 1", "sounds good", 2],
    ["Speaker 2", "one more thing", 3],
  ];

  for (const [speakerLabel, text, sequence] of lines) {
    await insertTranscriptLine({ meetingId, speakerLabel, text, sequence });
  }
});

describe("GET /api/meetings/:id/speakers", () => {
  it("lists distinct speakers in the order they first spoke", async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/speakers`);

    expect(res.status).toBe(200);
    expect(res.body.speakers).toEqual(["Speaker 1", "Speaker 2"]);
  });

  it("404s for a meeting that does not exist", async () => {
    const res = await request(app).get(`/api/meetings/${randomUUID()}/speakers`);
    expect(res.status).toBe(404);
  });

  it("400s on a non-UUID id rather than querying with it", async () => {
    const res = await request(app).get("/api/meetings/not-a-uuid/speakers");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid meeting id/);
  });
});

describe("PATCH /api/meetings/:id/speakers", () => {
  it("renames a speaker across every line they appear on", async () => {
    const res = await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 2", to: "Priya" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(res.body.speakers).toEqual(["Speaker 1", "Priya"]);

    const lines = await getTranscriptLines(meetingId);
    expect(lines.map((l) => l.speaker_label)).toEqual([
      "Speaker 1",
      "Priya",
      "Speaker 1",
      "Priya",
    ]);
  });

  it("leaves other speakers untouched", async () => {
    await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 1", to: "Alex" });

    const lines = await getTranscriptLines(meetingId);
    expect(lines.filter((l) => l.speaker_label === "Speaker 2")).toHaveLength(2);
  });

  it("merges two speakers when renamed onto an existing label", async () => {
    // A real correction: silence-gap detection does split one person in two.
    const res = await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 2", to: "Speaker 1" });

    expect(res.status).toBe(200);
    expect(res.body.speakers).toEqual(["Speaker 1"]);
  });

  it("trims surrounding whitespace from the new label", async () => {
    const res = await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 1", to: "   Alex   " });

    expect(res.body.speakers).toContain("Alex");
  });

  it("is a no-op when the label is unchanged", async () => {
    const res = await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 1", to: "Speaker 1" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });

  it("404s when no speaker carries the old label", async () => {
    const res = await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 9", to: "Nobody" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No speaker labelled/);
  });

  it("rejects an empty new label", async () => {
    const res = await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 1", to: "   " });

    expect(res.status).toBe(400);
  });

  it("rejects a label long enough to break the export layouts", async () => {
    const res = await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 1", to: "x".repeat(200) });

    expect(res.status).toBe(400);
  });

  it("rejects a missing body", async () => {
    const res = await request(app).patch(`/api/meetings/${meetingId}/speakers`).send({});
    expect(res.status).toBe(400);
  });

  it("404s for a meeting that does not exist", async () => {
    const res = await request(app)
      .patch(`/api/meetings/${randomUUID()}/speakers`)
      .send({ from: "Speaker 1", to: "Alex" });

    expect(res.status).toBe(404);
  });

  it("does not affect other meetings", async () => {
    const otherId = randomUUID();
    await createMeeting({ id: otherId, title: "Other" });
    await insertTranscriptLine({
      meetingId: otherId,
      speakerLabel: "Speaker 1",
      text: "unrelated",
      sequence: 0,
    });

    await request(app)
      .patch(`/api/meetings/${meetingId}/speakers`)
      .send({ from: "Speaker 1", to: "Alex" });

    const otherLines = await getTranscriptLines(otherId);
    expect(otherLines[0].speaker_label).toBe("Speaker 1");
  });
});
