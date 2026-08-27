/**
 * Meeting history: the three states the spec requires on every async surface —
 * loading, error with a retry, and a real empty state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeetingHistory } from "./MeetingHistory.jsx";
import { api, ApiError } from "../lib/api.js";

const noop = () => {};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("MeetingHistory", () => {
  it("shows a loading state while fetching", () => {
    vi.spyOn(api, "listMeetings").mockReturnValue(new Promise(() => {}));

    render(<MeetingHistory onOpen={noop} onStartRecording={noop} />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading meetings/i);
  });

  it("shows a real empty state, not blank space", async () => {
    vi.spyOn(api, "listMeetings").mockResolvedValue({ meetings: [] });

    render(<MeetingHistory onOpen={noop} onStartRecording={noop} />);

    expect(await screen.findByText(/no meetings yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record a meeting/i })).toBeInTheDocument();
  });

  it("routes the empty state's call to action to the recording screen", async () => {
    vi.spyOn(api, "listMeetings").mockResolvedValue({ meetings: [] });
    const onStartRecording = vi.fn();

    render(<MeetingHistory onOpen={noop} onStartRecording={onStartRecording} />);

    await userEvent.click(await screen.findByRole("button", { name: /record a meeting/i }));
    expect(onStartRecording).toHaveBeenCalled();
  });

  it("lists meetings with their status", async () => {
    vi.spyOn(api, "listMeetings").mockResolvedValue({
      meetings: [
        {
          id: "a",
          title: "Billing sync",
          startedAt: "2026-08-27T10:00:00Z",
          endedAt: "2026-08-27T10:12:00Z",
          status: "done",
        },
        {
          id: "b",
          title: "Failed one",
          startedAt: "2026-08-26T09:00:00Z",
          endedAt: null,
          status: "failed",
        },
      ],
    });

    render(<MeetingHistory onOpen={noop} onStartRecording={noop} />);

    expect(await screen.findByText("Billing sync")).toBeInTheDocument();
    expect(screen.getByText("Failed one")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("opens a meeting when clicked", async () => {
    vi.spyOn(api, "listMeetings").mockResolvedValue({
      meetings: [
        { id: "abc", title: "Billing sync", startedAt: "2026-08-27T10:00:00Z", endedAt: null, status: "done" },
      ],
    });
    const onOpen = vi.fn();

    render(<MeetingHistory onOpen={onOpen} onStartRecording={noop} />);

    await userEvent.click(await screen.findByText("Billing sync"));
    expect(onOpen).toHaveBeenCalledWith("abc");
  });

  it("shows an error with a retry affordance, never a silent failure", async () => {
    const listMeetings = vi
      .spyOn(api, "listMeetings")
      .mockRejectedValueOnce(new ApiError("Could not reach the server."))
      .mockResolvedValue({ meetings: [] });

    render(<MeetingHistory onOpen={noop} onStartRecording={noop} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load your meetings/i);

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(screen.getByText(/no meetings yet/i)).toBeInTheDocument());
    expect(listMeetings).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server's own message rather than a status code", async () => {
    vi.spyOn(api, "listMeetings").mockRejectedValue(
      new ApiError("Could not reach the server. It may be waking up — try again in a moment."),
    );

    render(<MeetingHistory onOpen={noop} onStartRecording={noop} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/waking up/i);
  });
});
