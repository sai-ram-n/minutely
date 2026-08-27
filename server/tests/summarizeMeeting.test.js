/**
 * Summarization orchestration.
 *
 * The central guarantee under test: a meeting NEVER ends up stuck in
 * "processing". Every path leaves it either "done" or "failed", because a
 * meeting stuck mid-processing is exactly the invisible dead end the spec
 * calls out.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  summarizeMeeting,
  EmptyTranscriptError,
  MeetingNotFoundError,
} from "../src/services/summarize.js";
import { migrate } from "../src/services/migrate.js";
import {
  closeClient,
  createMeeting,
  getMeeting,
  getMinutes,
  insertTranscriptLine,
  updateMeetingStatus,
} from "../src/services/db.js";
import { createFakeProvider } from "./helpers/fakeProvider.js";
import { HttpError } from "../src/ai/retry.js";

beforeAll(async () => {
  await migrate({ logger: { info: () => {} } });
});

afterAll(() => {
  closeClient();
});

let meetingId;

beforeEach(async () => {
  meetingId = randomUUID();
  await createMeeting({ id: meetingId, title: "Summarization test" });
  await insertTranscriptLine({
    meetingId,
    speakerLabel: "Speaker 1",
    text: "we should ship on Friday",
    sequence: 0,
  });
  await updateMeetingStatus(meetingId, "processing");
});

describe("summarizeMeeting — success", () => {
  it("stores minutes and marks the meeting done", async () => {
    const provider = createFakeProvider();
    const result = await summarizeMeeting(meetingId, { provider });

    expect(result.decisions).toEqual(["Adopt the fake provider for tests"]);
    expect((await getMeeting(meetingId)).status).toBe("done");
  });

  it("round-trips structured values through the TEXT columns", async () => {
    const minutes = {
      decisions: ["Ship on Friday", "Freeze the schema"],
      action_items: [
        { task: "Run the migration", owner: "Priya", due: "Thursday" },
        { task: "Write the rollback doc", owner: "Unassigned", due: "Not specified" },
      ],
      open_questions: ["Do we grandfather existing pricing?"],
    };

    await summarizeMeeting(meetingId, { provider: createFakeProvider({ minutes }) });

    const stored = await getMinutes(meetingId);
    expect(stored.decisions).toEqual(minutes.decisions);
    expect(stored.action_items).toEqual(minutes.action_items);
    expect(stored.open_questions).toEqual(minutes.open_questions);
    expect(stored.generated_at).toBeTruthy();
  });

  it("passes the full speaker-attributed transcript to the provider", async () => {
    await insertTranscriptLine({
      meetingId,
      speakerLabel: "Speaker 2",
      text: "I will run the migration",
      sequence: 1,
    });

    const provider = createFakeProvider();
    await summarizeMeeting(meetingId, { provider });

    const transcript = provider.summarize.mock.calls[0][0];
    expect(transcript).toContain("Speaker 1: we should ship on Friday");
    expect(transcript).toContain("Speaker 2: I will run the migration");
  });

  it("replaces existing minutes when run a second time", async () => {
    await summarizeMeeting(meetingId, { provider: createFakeProvider() });

    const second = {
      decisions: ["A completely different decision"],
      action_items: [],
      open_questions: [],
    };
    await summarizeMeeting(meetingId, { provider: createFakeProvider({ minutes: second }) });

    const stored = await getMinutes(meetingId);
    expect(stored.decisions).toEqual(["A completely different decision"]);
  });

  it("accepts genuinely empty minutes without treating them as a failure", async () => {
    // A meeting can decide nothing. That is a valid result, not an error.
    const empty = { decisions: [], action_items: [], open_questions: [] };
    await summarizeMeeting(meetingId, { provider: createFakeProvider({ minutes: empty }) });

    expect((await getMeeting(meetingId)).status).toBe("done");
    expect((await getMinutes(meetingId)).decisions).toEqual([]);
  });
});

describe("summarizeMeeting — failure", () => {
  it("marks the meeting failed and rethrows when the provider throws", async () => {
    const provider = createFakeProvider({ summarizeError: new Error("groq is down") });

    await expect(summarizeMeeting(meetingId, { provider })).rejects.toThrow("groq is down");
    expect((await getMeeting(meetingId)).status).toBe("failed");
  });

  it("never leaves a meeting stuck in processing", async () => {
    const provider = createFakeProvider({
      summarizeError: new HttpError(429, "rate limited"),
    });

    await expect(summarizeMeeting(meetingId, { provider })).rejects.toBeTruthy();

    const meeting = await getMeeting(meetingId);
    expect(meeting.status).not.toBe("processing");
    expect(meeting.status).toBe("failed");
  });

  it("stores no minutes when summarization fails", async () => {
    const provider = createFakeProvider({ summarizeError: new Error("nope") });
    await expect(summarizeMeeting(meetingId, { provider })).rejects.toBeTruthy();

    expect(await getMinutes(meetingId)).toBeNull();
  });

  it("fails with a specific error when nothing was transcribed", async () => {
    const emptyMeeting = randomUUID();
    await createMeeting({ id: emptyMeeting, title: "Silent meeting" });

    await expect(
      summarizeMeeting(emptyMeeting, { provider: createFakeProvider() }),
    ).rejects.toBeInstanceOf(EmptyTranscriptError);

    expect((await getMeeting(emptyMeeting)).status).toBe("failed");
  });

  it("marks an empty transcript as not worth retrying", async () => {
    const emptyMeeting = randomUUID();
    await createMeeting({ id: emptyMeeting, title: "Silent meeting" });

    const error = await summarizeMeeting(emptyMeeting, {
      provider: createFakeProvider(),
    }).catch((e) => e);

    // Retrying cannot conjure a transcript, so the UI must not offer it.
    expect(error.retryable).toBe(false);
  });

  it("does not call the provider when there is no transcript", async () => {
    const emptyMeeting = randomUUID();
    await createMeeting({ id: emptyMeeting, title: "Silent meeting" });

    const provider = createFakeProvider();
    await summarizeMeeting(emptyMeeting, { provider }).catch(() => {});

    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("throws for a meeting that does not exist", async () => {
    await expect(
      summarizeMeeting(randomUUID(), { provider: createFakeProvider() }),
    ).rejects.toBeInstanceOf(MeetingNotFoundError);
  });
});

describe("getMinutes", () => {
  it("returns null when no minutes exist yet", async () => {
    expect(await getMinutes(meetingId)).toBeNull();
  });

  it("degrades to empty rather than throwing on a corrupt column", async () => {
    const { getClient } = await import("../src/services/db.js");
    await getClient().execute({
      sql: `INSERT INTO minutes (meeting_id, decisions, action_items, open_questions, generated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [meetingId, "{not json", "[]", "[]", new Date().toISOString()],
    });

    const stored = await getMinutes(meetingId);
    // One bad column degrades one section, it does not break the page.
    expect(stored.decisions).toEqual([]);
    expect(stored.action_items).toEqual([]);
  });
});
