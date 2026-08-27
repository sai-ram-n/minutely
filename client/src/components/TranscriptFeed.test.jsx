/**
 * Transcript feed: empty states, the honesty caption, and inline renaming.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TranscriptFeed } from "./TranscriptFeed.jsx";

const LINES = [
  { speakerLabel: "Speaker 1", text: "we should ship on Friday", sequence: 0, timestamp: "t" },
  { speakerLabel: "Speaker 2", text: "I will run the migration", sequence: 1, timestamp: "t" },
  { speakerLabel: "Speaker 1", text: "sounds good", sequence: 2, timestamp: "t" },
];

describe("TranscriptFeed — empty states", () => {
  it("shows a real empty state when not recording", () => {
    render(<TranscriptFeed lines={[]} />);
    expect(screen.getByText(/no transcript yet/i)).toBeInTheDocument();
  });

  it("explains the delay while waiting for the first line", () => {
    render(<TranscriptFeed lines={[]} isRecording awaitingFirstLine />);

    // Silence for 20s would otherwise look like a hang.
    expect(screen.getByRole("status")).toHaveTextContent(/about 20 seconds/i);
  });
});

describe("TranscriptFeed — rendering", () => {
  it("renders each line with its speaker", () => {
    render(<TranscriptFeed lines={LINES} />);

    expect(screen.getByText("we should ship on Friday")).toBeInTheDocument();
    expect(screen.getByText("I will run the migration")).toBeInTheDocument();
    expect(screen.getAllByText("Speaker 1")).toHaveLength(2);
  });

  it("states the speaker-accuracy limitation in the UI, not just the docs", () => {
    render(<TranscriptFeed lines={LINES} />);

    expect(screen.getByText(/not voice recognition/i)).toBeInTheDocument();
    expect(screen.getByText(/more than two people/i)).toBeInTheDocument();
  });

  it("indicates it is still listening while recording", () => {
    render(<TranscriptFeed lines={LINES} isRecording />);
    expect(screen.getByText(/still listening/i)).toBeInTheDocument();
  });
});

describe("TranscriptFeed — renaming", () => {
  it("offers a rename control per distinct speaker", () => {
    render(<TranscriptFeed lines={LINES} onRenameSpeaker={vi.fn()} />);

    expect(screen.getByRole("button", { name: /rename speaker 1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rename speaker 2/i })).toBeInTheDocument();
  });

  it("hides rename controls when no handler is supplied", () => {
    render(<TranscriptFeed lines={LINES} />);
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument();
  });

  it("submits a new name", async () => {
    const onRenameSpeaker = vi.fn().mockResolvedValue(undefined);
    render(<TranscriptFeed lines={LINES} onRenameSpeaker={onRenameSpeaker} />);

    await userEvent.click(screen.getByRole("button", { name: /rename speaker 2/i }));
    const input = screen.getByLabelText(/new name for speaker 2/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Priya");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onRenameSpeaker).toHaveBeenCalledWith("Speaker 2", "Priya");
  });

  it("does not call the server for an unchanged name", async () => {
    const onRenameSpeaker = vi.fn();
    render(<TranscriptFeed lines={LINES} onRenameSpeaker={onRenameSpeaker} />);

    await userEvent.click(screen.getByRole("button", { name: /rename speaker 1/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onRenameSpeaker).not.toHaveBeenCalled();
  });

  it("does not accept an empty name", async () => {
    const onRenameSpeaker = vi.fn();
    render(<TranscriptFeed lines={LINES} onRenameSpeaker={onRenameSpeaker} />);

    await userEvent.click(screen.getByRole("button", { name: /rename speaker 1/i }));
    await userEvent.clear(screen.getByLabelText(/new name for speaker 1/i));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onRenameSpeaker).not.toHaveBeenCalled();
  });

  it("cancels with Escape", async () => {
    render(<TranscriptFeed lines={LINES} onRenameSpeaker={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /rename speaker 1/i }));
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByLabelText(/new name for speaker 1/i)).not.toBeInTheDocument();
  });

  it("shows an error when renaming fails and keeps the transcript", async () => {
    const onRenameSpeaker = vi.fn().mockRejectedValue(new Error("Server said no."));
    render(<TranscriptFeed lines={LINES} onRenameSpeaker={onRenameSpeaker} />);

    await userEvent.click(screen.getByRole("button", { name: /rename speaker 1/i }));
    const input = screen.getByLabelText(/new name for speaker 1/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Alex");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/server said no/i);
    expect(screen.getByText("we should ship on Friday")).toBeInTheDocument();
  });
});
