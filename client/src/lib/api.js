/**
 * REST client.
 *
 * Every call returns a readable Error message suitable for showing the user —
 * never a raw status code, and never a server internal.
 */

import { API_BASE } from "./config.js";

/** Error carrying whether the UI should offer a retry. */
export class ApiError extends Error {
  /** @param {string} message @param {{ status?: number, retryable?: boolean }} [details] */
  constructor(message, details = {}) {
    super(message);
    this.name = "ApiError";
    this.status = details.status;
    // Default true: most failures are transient (network, cold start, rate limit).
    this.retryable = details.retryable !== false;
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function request(path, init = {}) {
  let response;

  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      ...init,
    });
  } catch {
    // The free backend sleeps after inactivity, so the first request after a
    // quiet period genuinely can fail or hang. Say so rather than "failed to fetch".
    throw new ApiError(
      "Could not reach the server. It may be waking up — try again in a moment.",
      { retryable: true },
    );
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, {
      status: response.status,
      retryable: body?.retryable !== false,
    });
  }

  return body;
}

export const api = {
  version: () => request("/version"),
  health: () => request("/health"),

  listMeetings: () => request("/meetings"),
  getMeeting: (id) => request(`/meetings/${id}`),
  getMinutes: (id) => request(`/meetings/${id}/minutes`),

  /** Regenerate minutes from the stored transcript — no re-recording needed. */
  summarize: (id) => request(`/meetings/${id}/summarize`, { method: "POST" }),

  renameSpeaker: (id, from, to) =>
    request(`/meetings/${id}/speakers`, {
      method: "PATCH",
      body: JSON.stringify({ from, to }),
    }),
};
