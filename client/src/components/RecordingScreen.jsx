/**
 * Recording screen.
 *
 * Owns the mic lifecycle and shows connection state honestly: on a free host
 * the socket really does drop, and hiding that would leave the user staring at
 * a transcript that has quietly stopped growing.
 */

import { useState } from "react";
import { TranscriptFeed } from "./TranscriptFeed.jsx";
import { Spinner, ErrorState } from "./ui.jsx";

const CONNECTION = {
  idle: { label: "Connecting…", tone: "warn" },
  connecting: { label: "Connecting…", tone: "warn" },
  open: { label: "Connected", tone: "ok" },
  reconnecting: { label: "Reconnecting…", tone: "warn" },
  closed: { label: "Disconnected", tone: "error" },
};

/**
 * @param {Object} props
 * @param {ReturnType<import("../hooks/useMeetingSocket.js").useMeetingSocket>} props.session
 * @param {(meetingId: string) => void} props.onViewMinutes
 */
export function RecordingScreen({ session, onViewMinutes }) {
  const {
    connectionState,
    meetingStatus,
    meetingId,
    lines,
    notices,
    error,
    start,
    stop,
    dismissError,
    renameSpeaker,
  } = session;

  const [title, setTitle] = useState("");

  const isRecording = meetingStatus === "recording";
  const isStarting = meetingStatus === "starting";
  const isStopping = meetingStatus === "stopping" || meetingStatus === "stopped";
  const isProcessing = meetingStatus === "processing";
  const isDone = meetingStatus === "done";
  const isFailed = meetingStatus === "failed";

  const connection = CONNECTION[connectionState] ?? CONNECTION.idle;
  const canStart = connectionState === "open" && !isStarting && !isStopping && !isProcessing;

  return (
    <>
      <h1>Record a meeting</h1>
      <p className="subtitle">
        Audio is transcribed as you speak. Minutes are generated when you stop.
      </p>

      {connectionState !== "open" && (
        <div className={`banner banner--${connection.tone}`} role="status">
          <div className="banner__body">
            <strong className="banner__title">{connection.label}</strong>
            {connectionState === "reconnecting"
              ? "The connection dropped. Audio recorded now is held and sent once it is back."
              : "Waiting for the server. If it has been idle it may take up to a minute to wake."}
          </div>
          {connectionState !== "closed" && <Spinner label={connection.label} />}
        </div>
      )}

      {error && (
        <ErrorState
          title="Recording problem"
          message={error}
          onRetry={dismissError}
          retryLabel="Dismiss"
        />
      )}

      {notices.map((notice) => (
        <div className="banner banner--warn" role="status" key={notice.id}>
          <div className="banner__body">{notice.message}</div>
        </div>
      ))}

      <div className="card">
        <div className="field">
          <input
            className="input"
            value={title}
            maxLength={200}
            placeholder="Meeting title (optional)"
            aria-label="Meeting title"
            disabled={isRecording || isStarting || isStopping}
            onChange={(event) => setTitle(event.target.value)}
          />

          {isRecording ? (
            <button type="button" className="btn btn--danger" onClick={stop}>
              Stop recording
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => start(title.trim() || "Untitled meeting")}
              disabled={!canStart}
            >
              {isStarting && <Spinner label="Starting" />}
              {isStarting ? "Starting…" : "Start recording"}
            </button>
          )}
        </div>

        {isRecording && (
          <div className="row" style={{ marginTop: "0.85rem" }}>
            <span className="pill pill--recording">
              <span className="dot-pulse" aria-hidden="true" />
              Recording
            </span>
            <span className="caption">
              Audio is sent in ~20 second chunks, so the transcript trails slightly behind.
            </span>
          </div>
        )}

        {(isStopping || isProcessing) && (
          <div className="row" style={{ marginTop: "0.85rem" }} role="status" aria-live="polite">
            <Spinner label="Processing" />
            <span className="caption">
              {isProcessing
                ? "Generating minutes from the transcript…"
                : "Finishing the last audio chunk…"}
            </span>
          </div>
        )}

        {isDone && meetingId && (
          <div className="banner banner--ok" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
            <div className="banner__body">
              <strong className="banner__title">Minutes are ready</strong>
              Your meeting has been summarized.
            </div>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => onViewMinutes(meetingId)}
            >
              View minutes
            </button>
          </div>
        )}

        {isFailed && meetingId && (
          <div className="banner banner--error" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
            <div className="banner__body">
              <strong className="banner__title">Minutes could not be generated</strong>
              {error ?? "The transcript was saved. You can retry from the meeting page."}
            </div>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => onViewMinutes(meetingId)}
            >
              Open meeting
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Transcript</h2>
        <TranscriptFeed
          lines={lines}
          isRecording={isRecording}
          awaitingFirstLine={isRecording && lines.length === 0}
          onRenameSpeaker={lines.length > 0 ? renameSpeaker : undefined}
        />
      </div>
    </>
  );
}

export default RecordingScreen;
