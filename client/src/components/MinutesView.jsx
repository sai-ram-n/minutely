/**
 * Minutes of meeting.
 *
 * Handles four states explicitly: loading, failed (with a retry that is only
 * offered when retrying can actually help), still processing, and ready.
 */

import { useState } from "react";
import { api } from "../lib/api.js";
import { useAsync } from "../hooks/useAsync.js";
import { TranscriptFeed } from "./TranscriptFeed.jsx";
import { ExportButtons } from "./ExportButtons.jsx";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Spinner,
  StatusPill,
  formatDateTime,
  formatDuration,
} from "./ui.jsx";

/** @param {{ meetingId: string, onBack: () => void }} props */
export function MinutesView({ meetingId, onBack }) {
  const { data, error, loading, run, setData } = useAsync(
    () => api.getMeeting(meetingId),
    { deps: [meetingId] },
  );

  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(/** @type {string | null} */ (null));

  if (loading) return <LoadingState message="Loading meeting…" />;

  if (error) {
    return (
      <ErrorState
        title="Could not load this meeting"
        message={error.message}
        onRetry={error.retryable === false ? undefined : run}
      />
    );
  }

  if (!data) return null;

  const { meeting, transcript, minutes } = data;

  async function retrySummarize() {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.summarize(meetingId);
      await run();
    } catch (err) {
      setRetryError(err.message);
      // A non-retryable failure (nothing was transcribed) must stop offering
      // a button that can only fail again.
      if (err.retryable === false) setData({ ...data, meeting: { ...meeting, status: "failed" } });
    } finally {
      setRetrying(false);
    }
  }

  async function handleRename(from, to) {
    await api.renameSpeaker(meetingId, from, to);
    await run();
  }

  const duration = formatDuration(meeting.startedAt, meeting.endedAt);
  const canRetry = retryError === null || retrying;

  return (
    <>
      <button type="button" className="btn btn--sm btn--ghost" onClick={onBack}>
        ← Back
      </button>

      <div className="row row--between" style={{ marginTop: "1rem" }}>
        <h1 style={{ margin: 0 }}>{meeting.title}</h1>
        <StatusPill status={meeting.status} />
      </div>

      <p className="subtitle" style={{ marginTop: "0.35rem" }}>
        {formatDateTime(meeting.startedAt)}
        {duration ? ` · ${duration}` : ""}
        {` · ${transcript.length} line${transcript.length === 1 ? "" : "s"}`}
      </p>

      <div style={{ marginBottom: "1.25rem" }}>
        <ExportButtons meetingId={meetingId} disabled={meeting.status === "recording"} />
      </div>

      {meeting.status === "failed" && (
        <ErrorState
          title="Minutes could not be generated"
          message={
            retryError ??
            "The transcript below was saved. Generating the summary failed."
          }
          onRetry={canRetry ? retrySummarize : undefined}
          retryLabel="Generate minutes"
          busy={retrying}
        />
      )}

      {meeting.status === "processing" && (
        <div className="banner banner--warn" role="status" aria-live="polite">
          <Spinner label="Processing" />
          <div className="banner__body">
            <strong className="banner__title">Generating minutes…</strong>
            This usually takes a few seconds.
          </div>
          <button type="button" className="btn btn--sm btn--ghost" onClick={run}>
            Refresh
          </button>
        </div>
      )}

      {meeting.status === "recording" && (
        <div className="banner banner--warn" role="status">
          <span className="dot-pulse" aria-hidden="true" />
          <div className="banner__body">
            This meeting is still recording. Minutes are generated once it stops.
          </div>
        </div>
      )}

      <div className="card">
        <h2>Minutes</h2>

        {!minutes ? (
          meeting.status === "failed" ? (
            <EmptyState
              icon="⚠"
              title="No minutes were generated"
              body="The transcript was saved. Use the retry above to generate minutes without re-recording."
            />
          ) : (
            <EmptyState
              icon="◌"
              title="No minutes yet"
              body="Minutes appear here once this meeting has been summarized."
            />
          )
        ) : (
          <>
            <Section title="Decisions" count={minutes.decisions.length} empty="No decisions were recorded in this meeting.">
              <ul className="list">
                {minutes.decisions.map((decision, index) => (
                  <li key={index}>{decision}</li>
                ))}
              </ul>
            </Section>

            <Section
              title="Action items"
              count={minutes.action_items.length}
              empty="Nobody committed to anything in this meeting."
            >
              <div>
                {minutes.action_items.map((item, index) => (
                  <div className="action" key={index}>
                    <div className="action__task">{item.task}</div>
                    <div className="action__meta">
                      <span>
                        Owner: <b>{item.owner}</b>
                      </span>
                      <span>
                        Due: <b>{item.due}</b>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section
              title="Open questions"
              count={minutes.open_questions.length}
              empty="Nothing was left unresolved."
            >
              <ul className="list">
                {minutes.open_questions.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ul>
            </Section>

            <p className="caption" style={{ marginTop: "1.25rem" }}>
              Generated {formatDateTime(minutes.generated_at)} · summarized by AI from the
              transcript below, so check anything you plan to act on.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>Transcript</h2>
        <TranscriptFeed lines={transcript} onRenameSpeaker={handleRename} />
      </div>
    </>
  );
}

/**
 * A minutes section. An empty section renders explanatory text rather than
 * nothing, so "no decisions" is distinguishable from "not loaded".
 */
function Section({ title, count, empty, children }) {
  return (
    <div className="section">
      <div className="section__head">
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="section__count">{count}</span>
      </div>
      {count === 0 ? <p className="caption">{empty}</p> : children}
    </div>
  );
}

export default MinutesView;
