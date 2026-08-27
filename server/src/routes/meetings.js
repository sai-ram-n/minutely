/**
 * Meeting routes.
 *
 * Phase 4 adds speaker listing and renaming. The rest of the REST surface
 * (listing meetings, fetching one, exports) lands with the UI in Phase 6.
 */

import { Router } from "express";
import { z } from "zod";
import { logger } from "../config/logger.js";
import { getMeeting, listSpeakers, renameSpeaker } from "../services/db.js";

const meetingIdSchema = z.string().uuid();

const renameSchema = z.object({
  from: z.string().trim().min(1, "from is required").max(60),
  // Bounded because it is rendered in the transcript, the PDF and the Markdown
  // export; an unbounded label would break all three layouts.
  to: z.string().trim().min(1, "to is required").max(60),
});

export function createMeetingsRouter() {
  const router = Router();

  /** Rejects a non-UUID id before it reaches a query. */
  function parseMeetingId(req, res) {
    const result = meetingIdSchema.safeParse(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: "Invalid meeting id" });
      return null;
    }
    return result.data;
  }

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

  return router;
}
