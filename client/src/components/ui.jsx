/**
 * Shared UI primitives.
 *
 * Loading, error and empty states are required on every async surface, so they
 * live here rather than being re-invented per screen.
 */

/** @param {{ label?: string, size?: "sm" | "lg" }} props */
export function Spinner({ label = "Loading", size = "sm" }) {
  return (
    <>
      <span
        className={size === "lg" ? "spinner spinner--lg" : "spinner"}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </>
  );
}

/** A centred loading state for a whole panel. */
export function LoadingState({ message = "Loading…" }) {
  return (
    <div className="empty" role="status" aria-live="polite">
      <div className="row" style={{ justifyContent: "center" }}>
        <Spinner size="lg" label={message} />
      </div>
      <div className="empty__body" style={{ marginTop: "0.75rem" }}>
        {message}
      </div>
    </div>
  );
}

/**
 * An error with a retry affordance. Never render a failure without one unless
 * retrying genuinely cannot help.
 */
export function ErrorState({ title = "Something went wrong", message, onRetry, retryLabel = "Try again", busy }) {
  return (
    <div className="banner banner--error" role="alert">
      <div className="banner__body">
        <strong className="banner__title">{title}</strong>
        {message}
      </div>
      {onRetry && (
        <button type="button" className="btn btn--sm btn--ghost" onClick={onRetry} disabled={busy}>
          {busy ? <Spinner label="Retrying" /> : null}
          {busy ? "Retrying…" : retryLabel}
        </button>
      )}
    </div>
  );
}

/** Empty states are real UI, never blank space. */
export function EmptyState({ icon = "○", title, body, action }) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">{icon}</div>
      <div className="empty__title">{title}</div>
      {body && <div className="empty__body">{body}</div>}
      {action}
    </div>
  );
}

const STATUS_LABEL = {
  recording: "Recording",
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

/** @param {{ status: string }} props */
export function StatusPill({ status }) {
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span className={`pill pill--${status}`}>
      {status === "recording" && <span className="dot-pulse" aria-hidden="true" />}
      {status === "processing" && <Spinner label="Processing" />}
      {label}
    </span>
  );
}

/** Dates are shown in the viewer's locale; the raw ISO value stays in the title. */
export function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** @param {string | null} startedAt @param {string | null} endedAt */
export function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
