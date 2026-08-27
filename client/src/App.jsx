/**
 * Phase 3: a deliberately bare page.
 *
 * Its only job is to prove the pipeline end to end — microphone in, transcript
 * lines back. The real three-screen UI, with proper loading/error/empty states,
 * is Phase 6. Styling here is intentionally minimal and inline.
 */

import { useState } from "react";
import { useMeetingSocket } from "./hooks/useMeetingSocket.js";
import versionInfo from "./version.json";

const styles = {
  page: {
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    maxWidth: "44rem",
    margin: "0 auto",
    padding: "2rem 1.25rem 4rem",
    lineHeight: 1.5,
  },
  row: { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" },
  input: { flex: "1 1 16rem", padding: "0.5rem", fontSize: "1rem" },
  button: { padding: "0.5rem 1rem", fontSize: "1rem", cursor: "pointer" },
  line: { padding: "0.5rem 0", borderBottom: "1px solid #e5e5e5" },
  speaker: { fontWeight: 600, marginRight: "0.5rem" },
  banner: { padding: "0.75rem", borderRadius: "4px", margin: "0.75rem 0" },
  footer: { marginTop: "3rem", fontSize: "0.8rem", color: "#666" },
};

const CONNECTION_LABEL = {
  idle: "Not connected",
  connecting: "Connecting…",
  open: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
};

export default function App() {
  const [title, setTitle] = useState("");
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
  } = useMeetingSocket();

  const isRecording = meetingStatus === "recording";
  const isBusy = meetingStatus === "starting" || meetingStatus === "stopping";

  return (
    <main style={styles.page}>
      <h1>Minutely</h1>
      <p style={{ color: "#666", marginTop: "-0.5rem" }}>
        Phase 4 — turn detection. Bare page; the real UI comes in Phase 6.
      </p>

      <p>
        <strong>Connection:</strong> {CONNECTION_LABEL[connectionState] ?? connectionState}
        {meetingId ? ` · meeting ${meetingId.slice(0, 8)}…` : ""}
      </p>

      {error && (
        <div style={{ ...styles.banner, background: "#fdecea", border: "1px solid #f5c2c0" }}>
          <strong>Error:</strong> {error}{" "}
          <button type="button" onClick={dismissError} style={{ marginLeft: "0.5rem" }}>
            Dismiss
          </button>
        </div>
      )}

      {notices.map((notice) => (
        <div
          key={notice.id}
          style={{ ...styles.banner, background: "#fff8e1", border: "1px solid #ffe08a" }}
        >
          {notice.message}
        </div>
      ))}

      <div style={styles.row}>
        <input
          style={styles.input}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Meeting title"
          disabled={isRecording || isBusy}
          aria-label="Meeting title"
        />
        {isRecording ? (
          <button type="button" style={styles.button} onClick={stop} disabled={isBusy}>
            Stop recording
          </button>
        ) : (
          <button
            type="button"
            style={styles.button}
            onClick={() => start(title.trim() || "Untitled meeting")}
            disabled={isBusy || connectionState !== "open"}
          >
            {meetingStatus === "starting" ? "Starting…" : "Start recording"}
          </button>
        )}
      </div>

      <h2 style={{ marginTop: "2rem" }}>Transcript</h2>

      {lines.length === 0 ? (
        <p style={{ color: "#666" }}>
          {isRecording
            ? "Listening… the first line appears after about 20 seconds."
            : "Nothing yet. Start a recording to see the transcript."}
        </p>
      ) : (
        <div>
          {lines.map((line) => (
            <div key={line.sequence} style={styles.line}>
              <span style={styles.speaker}>{line.speakerLabel}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      )}

      {meetingStatus === "stopped" && (
        <p style={{ color: "#666" }}>
          Recording stopped. Summarization is wired in Phase 5.
        </p>
      )}

      <p style={{ marginTop: "2rem", fontSize: "0.85rem", color: "#666" }}>
        Speaker labels are inferred from pauses in the audio, not from voice
        recognition, so they may be wrong — especially with more than two people.
        You can rename any speaker.
      </p>

      <footer style={styles.footer}>
        {versionInfo.name} v{versionInfo.version} · {versionInfo.releaseDate}
      </footer>
    </main>
  );
}
