/**
 * Export affordances.
 *
 * Downloads go through fetch rather than a plain link so a failure surfaces as
 * a visible error instead of the browser navigating to a JSON error page — and
 * so the button can show a loading state while the PDF is generated.
 */

import { useState } from "react";
import { API_BASE } from "../lib/config.js";
import { Spinner } from "./ui.jsx";

/** Pulls the filename out of Content-Disposition, preferring the UTF-8 form. */
function filenameFrom(disposition, fallback) {
  if (!disposition) return fallback;

  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // Fall through to the ASCII form.
    }
  }

  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain ? plain[1] : fallback;
}

/** @param {{ meetingId: string, disabled?: boolean }} props */
export function ExportButtons({ meetingId, disabled }) {
  const [busy, setBusy] = useState(/** @type {null | "md" | "pdf"} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  async function download(format) {
    setBusy(format);
    setError(null);

    let objectUrl;
    try {
      const response = await fetch(
        `${API_BASE}/api/meetings/${meetingId}/export.${format}`,
      );

      if (!response.ok) {
        let message = `Export failed (${response.status})`;
        try {
          const body = await response.json();
          if (body?.error) message = body.error;
        } catch {
          // Non-JSON error body; keep the status-based message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const filename = filenameFrom(
        response.headers.get("content-disposition"),
        `meeting.${format}`,
      );

      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setError(
        err?.message?.includes("fetch")
          ? "Could not reach the server. It may be waking up — try again in a moment."
          : (err?.message ?? "Export failed."),
      );
    } finally {
      // Revoking immediately can cancel the download in some browsers.
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
      setBusy(null);
    }
  }

  return (
    <>
      <div className="row">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => download("pdf")}
          disabled={disabled || busy !== null}
        >
          {busy === "pdf" ? <Spinner label="Generating PDF" /> : null}
          {busy === "pdf" ? "Generating…" : "Export PDF"}
        </button>

        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => download("md")}
          disabled={disabled || busy !== null}
        >
          {busy === "md" ? <Spinner label="Generating Markdown" /> : null}
          {busy === "md" ? "Generating…" : "Export Markdown"}
        </button>
      </div>

      {error && (
        <div className="banner banner--error" role="alert" style={{ marginTop: "0.75rem" }}>
          <div className="banner__body">
            <strong className="banner__title">Export failed</strong>
            {error}
          </div>
        </div>
      )}
    </>
  );
}

export default ExportButtons;
