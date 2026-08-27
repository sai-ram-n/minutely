/**
 * React binding for the meeting socket and the chunked recorder.
 *
 * Owns the lifecycle: microphone permission, recording, chunk upload, live
 * transcript, and the connection state the UI surfaces.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createMeetingClient, blobToBase64 } from "../lib/meetingClient.js";
import { createChunkedRecorder } from "../lib/audioRecorder.js";
import { websocketUrl } from "../lib/config.js";

/**
 * @typedef {Object} TranscriptLine
 * @property {string} speakerLabel
 * @property {string} text
 * @property {string} timestamp
 * @property {number} sequence
 */

export function useMeetingSocket() {
  const [connectionState, setConnectionState] = useState("idle");
  const [meetingStatus, setMeetingStatus] = useState("idle");
  const [lines, setLines] = useState(/** @type {TranscriptLine[]} */ ([]));
  const [notices, setNotices] = useState(/** @type {{id: number, message: string}[]} */ ([]));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [meetingId, setMeetingId] = useState(/** @type {string | null} */ (null));

  const clientRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const noticeId = useRef(0);

  const pushNotice = useCallback((message) => {
    const id = (noticeId.current += 1);
    setNotices((current) => [...current, { id, message }]);
    // Transient by design: a rate-limit warning should not linger forever.
    setTimeout(() => {
      setNotices((current) => current.filter((n) => n.id !== id));
    }, 8000);
  }, []);

  useEffect(() => {
    const client = createMeetingClient({
      url: websocketUrl(),
      onConnectionChange: setConnectionState,
      onEvent: (message) => {
        switch (message.type) {
          case "recording_started":
            setMeetingId(message.meetingId);
            setMeetingStatus("recording");
            break;

          case "transcript_line":
            setLines((current) => {
              // Replays after a reconnect can repeat a sequence.
              if (current.some((line) => line.sequence === message.sequence)) return current;
              return [...current, message].sort((a, b) => a.sequence - b.sequence);
            });
            break;

          case "transcription_error":
            pushNotice(message.message);
            break;

          case "recording_stopped":
            setMeetingStatus("stopped");
            break;

          case "processing":
            setMeetingStatus("processing");
            break;

          case "mom_ready":
            setMeetingStatus("done");
            break;

          case "mom_failed":
            setMeetingStatus("failed");
            setError(message.message);
            break;

          case "error":
            setError(message.message);
            break;

          default:
            break;
        }
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [pushNotice]);

  const start = useCallback(
    async (title) => {
      setError(null);
      setLines([]);
      setMeetingStatus("starting");

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        setMeetingStatus("idle");
        setError(
          err?.name === "NotAllowedError"
            ? "Microphone access was denied. Allow it in your browser and try again."
            : "No microphone available. Check that one is connected and try again.",
        );
        return;
      }

      streamRef.current = stream;
      clientRef.current?.startRecording(title);

      const recorder = createChunkedRecorder({
        stream,
        onError: (err) => setError(err.message),
        onChunk: async (chunk) => {
          try {
            const base64 = await blobToBase64(chunk.blob);
            clientRef.current?.sendChunk({
              base64,
              sequence: chunk.sequence,
              mimeType: chunk.mimeType,
              startOffsetMs: chunk.startOffsetMs,
              overlapMs: chunk.overlapMs,
            });
          } catch {
            pushNotice("A section of audio could not be sent.");
          }
        },
      });

      recorderRef.current = recorder;
      recorder.start();
    },
    [pushNotice],
  );

  const stop = useCallback(() => {
    setMeetingStatus("stopping");

    // Stop the recorder first so its final chunk is flushed and uploaded before
    // the server is told the meeting has ended.
    recorderRef.current?.stop();
    recorderRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    // Give the final chunk a moment to be encoded and queued.
    setTimeout(() => clientRef.current?.stopRecording(), 250);
  }, []);

  return {
    connectionState,
    meetingStatus,
    meetingId,
    lines,
    notices,
    error,
    start,
    stop,
    dismissError: () => setError(null),
  };
}
