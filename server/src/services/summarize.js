/**
 * Meeting summarization.
 *
 * Orchestrates: load the stored transcript, ask the provider for structured
 * minutes, persist them, and move the meeting to its final status.
 *
 * The prompt itself lives in ai/prompts.js and retry/backoff inside the
 * provider, so this module is only about sequencing and about making sure a
 * meeting NEVER ends up stuck in "processing" — every path here leaves it
 * either "done" or "failed".
 */

import { logger } from "../config/logger.js";
import {
  getMeeting,
  getTranscriptText,
  updateMeetingStatus,
  upsertMinutes,
} from "./db.js";

/**
 * Raised when there is nothing to summarize. Distinguished from a provider
 * failure because retrying will not help — the recording captured no speech.
 */
export class EmptyTranscriptError extends Error {
  constructor() {
    super("No speech was transcribed, so there is nothing to summarize.");
    this.name = "EmptyTranscriptError";
    this.retryable = false;
  }
}

/** Raised when the meeting id does not exist. */
export class MeetingNotFoundError extends Error {
  /** @param {string} meetingId */
  constructor(meetingId) {
    super(`Meeting ${meetingId} not found`);
    this.name = "MeetingNotFoundError";
    this.retryable = false;
  }
}

/**
 * Generates and stores minutes for a meeting.
 *
 * On success the meeting becomes "done". On failure it becomes "failed" — never
 * left in "processing", which would be an invisible dead end for the user — and
 * the error is rethrown so the caller can report it.
 *
 * @param {string} meetingId
 * @param {Object} options
 * @param {import("../ai/provider.js").AiProvider} options.provider
 * @returns {Promise<import("../ai/provider.js").MinutesResult & { generated_at: string }>}
 */
export async function summarizeMeeting(meetingId, { provider }) {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new MeetingNotFoundError(meetingId);

  await updateMeetingStatus(meetingId, "processing");

  const transcript = (await getTranscriptText(meetingId)).trim();

  if (transcript === "") {
    // Not a provider failure, but still a failed meeting: the user needs to see
    // that nothing was captured rather than an empty minutes page.
    await updateMeetingStatus(meetingId, "failed");
    logger.warn({ meetingId }, "summarization skipped — transcript is empty");
    throw new EmptyTranscriptError();
  }

  const startedAt = Date.now();

  try {
    const minutes = await provider.summarize(transcript);
    const stored = await upsertMinutes(meetingId, minutes);

    await updateMeetingStatus(meetingId, "done");

    logger.info(
      {
        meetingId,
        ms: Date.now() - startedAt,
        decisions: minutes.decisions.length,
        actionItems: minutes.action_items.length,
        openQuestions: minutes.open_questions.length,
      },
      "minutes generated",
    );

    return stored;
  } catch (err) {
    await updateMeetingStatus(meetingId, "failed");
    logger.error(
      { meetingId, err: err.message, ms: Date.now() - startedAt },
      "summarization failed — meeting marked failed",
    );
    throw err;
  }
}
