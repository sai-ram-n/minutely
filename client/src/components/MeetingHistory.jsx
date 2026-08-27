/**
 * Meeting history.
 *
 * The empty state is the first thing a new user sees, so it is real UI with a
 * way forward rather than blank space.
 */

import { api } from "../lib/api.js";
import { useAsync } from "../hooks/useAsync.js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  StatusPill,
  formatDateTime,
  formatDuration,
} from "./ui.jsx";

/**
 * @param {Object} props
 * @param {(meetingId: string) => void} props.onOpen
 * @param {() => void} props.onStartRecording
 */
export function MeetingHistory({ onOpen, onStartRecording }) {
  const { data, error, loading, run } = useAsync(() => api.listMeetings());

  if (loading) return <LoadingState message="Loading meetings…" />;

  if (error) {
    return (
      <ErrorState
        title="Could not load your meetings"
        message={error.message}
        onRetry={run}
      />
    );
  }

  const meetings = data?.meetings ?? [];

  return (
    <>
      <div className="row row--between">
        <div>
          <h1 style={{ margin: 0 }}>Meetings</h1>
          <p className="subtitle" style={{ margin: "0.25rem 0 0" }}>
            {meetings.length === 0
              ? "Nothing recorded yet."
              : `${meetings.length} meeting${meetings.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <button type="button" className="btn btn--sm btn--ghost" onClick={run}>
          Refresh
        </button>
      </div>

      <div className="card" style={{ marginTop: "1.25rem" }}>
        {meetings.length === 0 ? (
          <EmptyState
            icon="🎙"
            title="No meetings yet"
            body="Record your first one and it will show up here with its transcript and minutes."
            action={
              <button type="button" className="btn btn--primary" onClick={onStartRecording}>
                Record a meeting
              </button>
            }
          />
        ) : (
          meetings.map((meeting) => {
            const duration = formatDuration(meeting.startedAt, meeting.endedAt);
            return (
              <button
                type="button"
                className="meeting"
                key={meeting.id}
                onClick={() => onOpen(meeting.id)}
              >
                <div className="meeting__body">
                  <div className="meeting__title">{meeting.title}</div>
                  <div className="meeting__meta">
                    {formatDateTime(meeting.startedAt)}
                    {duration ? ` · ${duration}` : ""}
                  </div>
                </div>
                <StatusPill status={meeting.status} />
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

export default MeetingHistory;
