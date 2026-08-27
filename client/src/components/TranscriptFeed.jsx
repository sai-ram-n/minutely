/**
 * Live and stored transcript.
 *
 * Carries the speaker-accuracy caption directly under the transcript, where
 * someone reading the labels will actually see it — a product that is honest
 * about its limits reads as more trustworthy than one that overclaims.
 */

import { useEffect, useRef, useState } from "react";
import { EmptyState, Spinner } from "./ui.jsx";

/**
 * @param {Object} props
 * @param {{ speakerLabel: string, text: string, sequence: number, timestamp?: string }[]} props.lines
 * @param {boolean} [props.isRecording]
 * @param {boolean} [props.awaitingFirstLine]
 * @param {(from: string, to: string) => Promise<void>} [props.onRenameSpeaker]
 */
export function TranscriptFeed({ lines, isRecording, awaitingFirstLine, onRenameSpeaker }) {
  const endRef = useRef(null);
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState(/** @type {string | null} */ (null));

  // Follow the transcript while recording, but never yank the page around when
  // the user is reading a finished meeting.
  useEffect(() => {
    if (isRecording) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines.length, isRecording]);

  const speakers = [...new Set(lines.map((line) => line.speakerLabel))];

  async function submitRename(event) {
    event.preventDefault();
    const to = draft.trim();
    if (!editing || to === "" || to === editing) {
      setEditing(null);
      return;
    }

    setSaving(true);
    setRenameError(null);
    try {
      await onRenameSpeaker?.(editing, to);
      setEditing(null);
    } catch (err) {
      setRenameError(err.message ?? "Could not rename that speaker.");
    } finally {
      setSaving(false);
    }
  }

  if (lines.length === 0) {
    return (
      <>
        {awaitingFirstLine ? (
          <div className="empty" role="status" aria-live="polite">
            <div className="row" style={{ justifyContent: "center" }}>
              <Spinner size="lg" label="Listening" />
            </div>
            <div className="empty__body" style={{ marginTop: "0.75rem" }}>
              Listening… the first line appears after about 20 seconds of audio.
            </div>
          </div>
        ) : (
          <EmptyState
            icon="◌"
            title="No transcript yet"
            body="Start a recording and lines will appear here as you speak."
          />
        )}
      </>
    );
  }

  return (
    <>
      {onRenameSpeaker && speakers.length > 0 && (
        <div className="row" style={{ marginBottom: "0.75rem" }}>
          <span className="caption">Speakers:</span>
          {speakers.map((speaker) =>
            editing === speaker ? (
              <form key={speaker} className="row" onSubmit={submitRename}>
                <input
                  className="input"
                  style={{ width: "9rem" }}
                  value={draft}
                  autoFocus
                  maxLength={60}
                  disabled={saving}
                  aria-label={`New name for ${speaker}`}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setEditing(null);
                  }}
                />
                <button type="submit" className="btn btn--sm btn--primary" disabled={saving}>
                  {saving ? <Spinner label="Saving" /> : null}
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => setEditing(null)}
                  disabled={saving}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                key={speaker}
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  setEditing(speaker);
                  setDraft(speaker);
                  setRenameError(null);
                }}
              >
                {speaker} <span aria-hidden="true">✎</span>
                <span className="sr-only">Rename {speaker}</span>
              </button>
            ),
          )}
        </div>
      )}

      {renameError && (
        <div className="banner banner--error" role="alert">
          <div className="banner__body">{renameError}</div>
        </div>
      )}

      <div className="transcript">
        {lines.map((line) => (
          <div className="line" key={line.sequence}>
            <div className="line__speaker" title={line.timestamp}>
              {line.speakerLabel}
            </div>
            <div className="line__text">{line.text}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {isRecording && (
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <Spinner label="Still recording" />
          <span className="caption">Still listening…</span>
        </div>
      )}

      <p className="caption" style={{ marginTop: "1rem" }}>
        Speaker labels come from pauses in the audio, not voice recognition, so
        they can be wrong — especially with more than two people. Click a speaker
        to rename them; renaming one onto another merges the two.
      </p>
    </>
  );
}

export default TranscriptFeed;
