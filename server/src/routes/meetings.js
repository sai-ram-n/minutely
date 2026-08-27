/**
 * Meeting routes.
 *
 * Phase 4 adds speaker listing and renaming. The rest of the REST surface
 * (listing meetings, fetching one, exports) lands with the UI in Phase 6.
 */

import { Router } from "express";
import { z } from "zod";
import { logger } from "../config/logger.js";
import {
  getMeeting,
  getMinutes,
  getTranscriptLines,
  listMeetings,
  listSpeakers,
  renameSpeaker,
} from "../services/db.js";
import { summarizeMeeting } from "../services/summarize.js";
import {
  buildMarkdown,
  buildPdf,
  exportFilename,
} from "../services/export.js";
import { readVersion } from "../config/env.js";
import { getProvider } from "../ai/index.js";

const meetingIdSchema = z.string().uuid();

const renameSchema = z.object({
  from: z.string().trim().min(1, "from is required").max(60),
  // Bounded because it is rendered in the transcript, the PDF and the Markdown
  // export; an unbounded label would break all three layouts.
  to: z.string().trim().min(1, "to is required").max(60),
});

/**
 * @param {Object} [options]
 * @param {import("../ai/provider.js").AiProvider} [options.provider] Injected by tests.
 */
export function createMeetingsRouter(options = {}) {
  const router = Router();
  const resolveProvider = () => options.provider ?? getProvider();

  /** Rejects a non-UUID id before it reaches a query. */
  function parseMeetingId(req, res) {
    const result = meetingIdSchema.safeParse(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: "Invalid meeting id" });
      return null;
    }
    return result.data;
  }

  /** Meeting history, newest first. */
  router.get("/", async (_req, res, next) => {
    try {
      const meetings = await listMeetings();
      res.json({
        meetings: meetings.map((meeting) => ({
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.started_at,
          endedAt: meeting.ended_at,
          status: meeting.status,
          speakerCount: meeting.speaker_count,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** One meeting with its transcript and minutes, for the detail screen. */
  router.get("/:id", async (req, res, next) => {
    try {
      const id = parseMeetingId(req, res);
      if (!id) return;

      const meeting = await getMeeting(id);
      if (!meeting) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }

      const [lines, minutes] = await Promise.all([
        getTranscriptLines(id),
        getMinutes(id),
      ]);

      res.json({
        meeting: {
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.started_at,
          endedAt: meeting.ended_at,
          status: meeting.status,
          speakerCount: meeting.speaker_count,
        },
        transcript: lines.map((line) => ({
          speakerLabel: line.speaker_label,
          text: line.text,
          timestamp: line.timestamp,
          sequence: line.sequence,
        })),
        minutes,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/speakers", async (req, res, next) => {
    try {
      const id = parseMeetingId(req, res);
      if (!id) return;

      const meeting = await getMeeting(id);
      if (!meeting) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }

      res.json({ speakers: await listSpeakers(id) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Rename a speaker across the whole transcript.
   *
   * Renaming to a label that already exists deliberately merges the two — a
   * reasonable correction when turn detection split one person in two, which
   * silence-gap detection genuinely does.
   */
  router.patch("/:id/speakers", async (req, res, next) => {
    try {
      const id = parseMeetingId(req, res);
      if (!id) return;

      const parsed = renameSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
        return;
      }

      const meeting = await getMeeting(id);
      if (!meeting) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }

      const { from, to } = parsed.data;

      if (from === to) {
        res.json({ updated: 0, speakers: await listSpeakers(id) });
        return;
      }

      const updated = await renameSpeaker(id, from, to);

      if (updated === 0) {
        res.status(404).json({ error: `No speaker labelled "${from}" in this meeting` });
        return;
      }

      logger.info({ meetingId: id, from, to, updated }, "speaker renamed");
      res.json({ updated, speakers: await listSpeakers(id) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Retry summarization.
   *
   * The spec requires a failed meeting to surface a retry affordance rather
   * than becoming an invisible dead end. The transcript is already stored, so
   * a retry costs one summarization call and no re-recording.
   */
  router.post("/:id/summarize", async (req, res, next) => {
    try {
      const id = parseMeetingId(req, res);
      if (!id) return;

      const meeting = await getMeeting(id);
      if (!meeting) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }

      if (meeting.status === "recording") {
        res.status(409).json({
          error: "This meeting is still recording. Stop it before generating minutes.",
        });
        return;
      }

      const minutes = await summarizeMeeting(id, { provider: resolveProvider() });
      res.json({ status: "done", minutes });
    } catch (err) {
      // Expected failure modes get a readable message and the right status;
      // anything else falls through to the generic handler.
      if (err?.name === "EmptyTranscriptError") {
        res.status(422).json({ error: err.message, retryable: false });
        return;
      }
      if (err?.status === 429) {
        res.status(429).json({
          error: "The AI service is rate limited right now. Try again in a moment.",
          retryable: true,
        });
        return;
      }
      if (err?.name === "HttpError" || /Summarization returned/.test(err?.message ?? "")) {
        res.status(502).json({
          error: "Could not generate minutes. You can try again.",
          retryable: true,
        });
        return;
      }
      next(err);
    }
  });

  /** The generated minutes for a meeting, if any exist yet. */
  router.get("/:id/minutes", async (req, res, next) => {
    try {
      const id = parseMeetingId(req, res);
      if (!id) return;

      const meeting = await getMeeting(id);
      if (!meeting) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }

      const minutes = await getMinutes(id);
      if (!minutes) {
        res.status(404).json({ error: "No minutes have been generated for this meeting yet" });
        return;
      }

      res.json({ status: meeting.status, minutes });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Loads everything an export needs, or writes the appropriate error.
   * @returns {Promise<import("../services/export.js").ExportInput | null>}
   */
  async function loadExportInput(req, res) {
    const id = parseMeetingId(req, res);
    if (!id) return null;

    const meeting = await getMeeting(id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found" });
      return null;
    }

    const [transcript, minutes] = await Promise.all([
      getTranscriptLines(id),
      getMinutes(id),
    ]);

    return {
      meeting: {
        id: meeting.id,
        title: meeting.title,
        startedAt: meeting.started_at,
        endedAt: meeting.ended_at,
        status: meeting.status,
      },
      transcript: transcript.map((line) => ({
        speakerLabel: line.speaker_label,
        text: line.text,
        sequence: line.sequence,
      })),
      minutes,
      version: readVersion(),
    };
  }

  /**
   * Content-Disposition with both a plain and a UTF-8 filename, so a title in
   * any script still produces a sensible download name.
   */
  function setDownloadHeaders(res, filename, contentType) {
    const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_");
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    // These are generated per request and reflect live data.
    res.setHeader("Cache-Control", "no-store");
  }

  router.get("/:id/export.md", async (req, res, next) => {
    try {
      const input = await loadExportInput(req, res);
      if (!input) return;

      const markdown = buildMarkdown(input);
      setDownloadHeaders(
        res,
        exportFilename(input.meeting, "md"),
        "text/markdown; charset=utf-8",
      );
      res.send(markdown);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/export.pdf", async (req, res, next) => {
    try {
      const input = await loadExportInput(req, res);
      if (!input) return;

      // Buffered, so a generation failure becomes a clean error rather than a
      // truncated download the user cannot tell is broken.
      const pdf = await buildPdf(input);

      setDownloadHeaders(res, exportFilename(input.meeting, "pdf"), "application/pdf");
      res.setHeader("Content-Length", pdf.length);
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
