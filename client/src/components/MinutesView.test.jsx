/**
 * Minutes view.
 *
 * The important behaviour is the failed path: a retry must be offered when it
 * can help, and must NOT be offered when it cannot.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MinutesView } from "./MinutesView.jsx";
import { api, ApiError } from "../lib/api.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

function meetingPayload(overrides = {}) {
  return {
    meeting: {
      id: MEETING_ID,
      title: "Billing rewrite sync",
      startedAt: "2026-08-27T10:00:00Z",
      endedAt: "2026-08-27T10:14:00Z",
      status: "done",
      ...overrides.meeting,
    },
    transcript: overrides.transcript ?? [
      { speakerLabel: "Speaker 1", text: "we should ship on Friday", sequence: 0, timestamp: "t" },
      { speakerLabel: "Speaker 2", text: "I will run the migration", sequence: 1, timestamp: "t" },
    ],
    minutes:
      overrides.minutes === undefined
        ? {
            decisions: ["Ship the billing rewrite on Friday"],
            action_items: [{ task: "Run the migration", owner: "Priya", due: "Thursday" }],
            open_questions: ["Do we grandfather existing pricing?"],
            generated_at: "2026-08-27T10:15:00Z",
          }
        : overrides.minutes,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("MinutesView — ready", () => {
  it("shows a loading state first", () => {
    vi.spyOn(api, "getMeeting").mockReturnValue(new Promise(() => {}));

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading meeting/i);
  });

  it("renders all three minutes sections", async () => {
    vi.spyOn(api, "getMeeting").mockResolvedValue(meetingPayload());

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    expect(await screen.findByText(/ship the billing rewrite on friday/i)).toBeInTheDocument();
    expect(screen.getByText("Run the migration")).toBeInTheDocument();
    expect(screen.getByText("Priya")).toBeInTheDocument();
    expect(screen.getByText("Thursday")).toBeInTheDocument();
    expect(screen.getByText(/grandfather existing pricing/i)).toBeInTheDocument();
  });

  it("explains an empty section rather than rendering nothing", async () => {
    vi.spyOn(api, "getMeeting").mockResolvedValue(
      meetingPayload({
        minutes: {
          decisions: [],
          action_items: [],
          open_questions: [],
          generated_at: "2026-08-27T10:15:00Z",
        },
      }),
    );

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    // "No decisions" must be distinguishable from "not loaded".
    expect(await screen.findByText(/no decisions were recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/nobody committed to anything/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was left unresolved/i)).toBeInTheDocument();
  });

  it("warns that the summary is AI-generated", async () => {
    vi.spyOn(api, "getMeeting").mockResolvedValue(meetingPayload());

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);
    expect(await screen.findByText(/summarized by AI/i)).toBeInTheDocument();
  });
});

describe("MinutesView — failed", () => {
  it("offers a retry when summarization failed", async () => {
    vi.spyOn(api, "getMeeting").mockResolvedValue(
      meetingPayload({ meeting: { status: "failed" }, minutes: null }),
    );

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be generated/i);
    expect(screen.getByRole("button", { name: /generate minutes/i })).toBeInTheDocument();
  });

  it("regenerates and reloads on retry", async () => {
    const getMeeting = vi
      .spyOn(api, "getMeeting")
      .mockResolvedValueOnce(meetingPayload({ meeting: { status: "failed" }, minutes: null }))
      .mockResolvedValue(meetingPayload());
    const summarize = vi.spyOn(api, "summarize").mockResolvedValue({ status: "done" });

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /generate minutes/i }));

    await waitFor(() =>
      expect(screen.getByText(/ship the billing rewrite on friday/i)).toBeInTheDocument(),
    );
    expect(summarize).toHaveBeenCalledWith(MEETING_ID);
    expect(getMeeting).toHaveBeenCalledTimes(2);
  });

  it("stops offering a retry once the failure is known to be unretryable", async () => {
    vi.spyOn(api, "getMeeting").mockResolvedValue(
      meetingPayload({ meeting: { status: "failed" }, minutes: null }),
    );
    vi.spyOn(api, "summarize").mockRejectedValue(
      new ApiError("No speech was transcribed, so there is nothing to summarize.", {
        status: 422,
        retryable: false,
      }),
    );

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /generate minutes/i }));

    // The reason replaces the button — a retry that can only fail is a dead end.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/nothing to summarize/i),
    );
    expect(screen.queryByRole("button", { name: /generate minutes/i })).not.toBeInTheDocument();
  });

  it("keeps the transcript visible when minutes failed", async () => {
    vi.spyOn(api, "getMeeting").mockResolvedValue(
      meetingPayload({ meeting: { status: "failed" }, minutes: null }),
    );

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    // The transcript is the valuable artefact; a failed summary must not hide it.
    expect(await screen.findByText(/we should ship on friday/i)).toBeInTheDocument();
  });
});

describe("MinutesView — load failure", () => {
  it("shows an error with a retry", async () => {
    vi.spyOn(api, "getMeeting")
      .mockRejectedValueOnce(new ApiError("Could not reach the server."))
      .mockResolvedValue(meetingPayload());

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load this meeting/i);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() =>
      expect(screen.getByText(/ship the billing rewrite on friday/i)).toBeInTheDocument(),
    );
  });
});

describe("MinutesView — speaker rename", () => {
  it("renames a speaker and reloads", async () => {
    vi.spyOn(api, "getMeeting").mockResolvedValue(meetingPayload());
    const rename = vi.spyOn(api, "renameSpeaker").mockResolvedValue({ updated: 1 });

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /rename speaker 2/i }));

    const input = screen.getByLabelText(/new name for speaker 2/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Priya");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(rename).toHaveBeenCalledWith(MEETING_ID, "Speaker 2", "Priya"));
  });

  it("shows an error when renaming fails, without losing the transcript", async () => {
    vi.spyOn(api, "getMeeting").mockResolvedValue(meetingPayload());
    vi.spyOn(api, "renameSpeaker").mockRejectedValue(new ApiError("Name is already taken."));

    render(<MinutesView meetingId={MEETING_ID} onBack={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /rename speaker 1/i }));
    const input = screen.getByLabelText(/new name for speaker 1/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Alex");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/name is already taken/i)).toBeInTheDocument();
    expect(screen.getByText(/we should ship on friday/i)).toBeInTheDocument();
  });
});
