/**
 * Pre-recording setup.
 *
 * Asks for the details that must be known before audio starts — in particular
 * how many people are in the room.
 *
 * That question is not a nicety. Speaker labels come from silence gaps, which
 * reveal that the speaker CHANGED but never who is talking, so the labels cycle
 * through a fixed set. Testing a real four-person recording with that set fixed
 * at two gave two different people the same label: worse than incomplete,
 * actively misleading. Asking up front is what makes the labels mean anything.
 */

import { useState } from "react";
import { Spinner } from "./ui.jsx";
import { SAMPLE_MEETING } from "../lib/sampleAudio.js";

export const MAX_SPEAKERS = 8;

/**
 * @param {Object} props
 * @param {(details: { title: string, speakerCount: number }) => void} props.onStart
 * @param {() => void} props.onStartSample
 * @param {boolean} props.canStart
 * @param {boolean} props.busy
 */
export function MeetingSetup({ onStart, onStartSample, canStart, busy }) {
  const [title, setTitle] = useState("");
  const [speakerCount, setSpeakerCount] = useState(2);

  function submit(event) {
    event.preventDefault();
    if (!canStart || busy) return;
    onStart({ title: title.trim() || "Untitled meeting", speakerCount });
  }

  return (
    <div className="card">
      <h2>Before you start</h2>

      <form onSubmit={submit} className="stack">
        <div>
          <label className="setup__label" htmlFor="meeting-title">
            Meeting title
          </label>
          <input
            id="meeting-title"
            className="input"
            value={title}
            maxLength={200}
            placeholder="e.g. Billing rewrite sync"
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
          <p className="caption">Optional — it becomes the name in your history.</p>
        </div>

        <div>
          <label className="setup__label" htmlFor="speaker-count">
            How many people are in this meeting?
          </label>

          <div className="chips" role="group" aria-labelledby="speaker-count">
            {Array.from({ length: MAX_SPEAKERS }, (_, index) => index + 1).map((count) => (
              <button
                type="button"
                key={count}
                className={`chip ${speakerCount === count ? "chip--active" : ""}`}
                aria-pressed={speakerCount === count}
                disabled={busy}
                onClick={() => setSpeakerCount(count)}
              >
                {count}
              </button>
            ))}
          </div>

          <p className="caption">
            Speakers are told apart by pauses in the audio, not by voice, so
            Minutely can tell that the speaker changed but not who is talking.
            Getting this number right is what makes the labels line up — set it
            to 2 for a four-person meeting and two different people end up
            sharing a label. You can rename anyone afterwards.
          </p>
        </div>

        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={!canStart || busy}>
            {busy && <Spinner label="Starting" />}
            {busy ? "Starting…" : "Start recording"}
          </button>

          <button
            type="button"
            className="btn btn--ghost"
            onClick={onStartSample}
            disabled={!canStart || busy}
          >
            Try a sample meeting
          </button>
        </div>

        {!canStart && !busy && (
          <p className="caption">Waiting for the server before recording can start…</p>
        )}

        <p className="caption">
          The sample runs a {SAMPLE_MEETING.approxSeconds}-second recording of{" "}
          {SAMPLE_MEETING.speakerCount} people through the real pipeline — no
          microphone needed. {SAMPLE_MEETING.attribution}.
        </p>
      </form>
    </div>
  );
}

export default MeetingSetup;
