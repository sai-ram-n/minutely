/**
 * Recording screen.
 *
 * Owns the mic lifecycle and shows connection state honestly: on a free host
 * the socket really does drop, and hiding that would leave the user staring at
 * a transcript that has quietly stopped growing.
 */

import { TranscriptFeed } from "./TranscriptFeed.jsx";
import { MeetingSetup } from "./MeetingSetup.jsx";
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
    isSample,
    start,
    startSample,
    stop,
    dismissError,
    renameSpeaker,
  } = session;

  const isRecording = meetingStatus === "recording";
  const isStarting = meetingStatus === "starting";
  const isStopping = meetingStatus === "stopping" || meetingStatus === "stopped";
  const isProcessing = meetingStatus === "processing";
  const isDone = meetingStatus === "done";
  const isFailed = meetingStatus === "failed";

  const connection = CONNECTION[connectionState] ?? CONNECTION.idle;

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

      {isSample && (
        <div className="sample-banner" role="status">
          <span className="dot-pulse" aria-hidden="true" />
          <span>
            Sample meeting — a recorded briefing played through the real
            pipeline. No microphone is being used.
          </span>
        </div>
      )}

      {!isRecording && !isStopping && !isProcessing && !isDone && !isFailed ? (
        <MeetingSetup
          onStart={start}
          onStartSample={startSample}
          canStart={connectionState === "open"}
          busy={isStarting}
        />
      ) : (
        <div className="card">
          <div className="row row--between">
            <div className="row">
              {isRecording && (
                <span className="pill pill--recording">
                  <span className="dot-pulse" aria-hidden="true" />
                  Recording
                </span>
              )}
              {(isStopping || isProcessing) && (
                <span className="pill pill--processing">
                  <Spinner label="Processing" />
                  {isProcessing ? "Generating minutes" : "Finishing up"}
                </span>
              )}
              {isDone && <span className="pill pill--done">Done</span>}
              {isFailed && <span className="pill pill--failed">Failed</span>}
            </div>

            {isRecording && (
              <button type="button" className="btn btn--danger" onClick={stop}>
                Stop recording
              </button>
            )}
          </div>

          {isRecording && (
            <p className="caption" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
              Audio is sent in ~20 second chunks, so the transcript trails
              slightly behind what is being said.
            </p>
          )}

          {(isStopping || isProcessing) && (
            <p className="caption" style={{ marginTop: "0.6rem", marginBottom: 0 }} role="status" aria-live="polite">
              {isProcessing
                ? "Generating minutes from the transcript…"
                : "Finishing the last audio chunk…"}
            </p>
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
      )}

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
