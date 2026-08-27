/**
 * Pre-recording setup.
 *
 * The participant count is the reason this screen exists: with it pinned at
 * two, a real four-person recording gave two different people the same label.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeetingSetup, MAX_SPEAKERS } from "./MeetingSetup.jsx";

function setup(overrides = {}) {
  const props = {
    onStart: vi.fn(),
    onStartSample: vi.fn(),
    canStart: true,
    busy: false,
    ...overrides,
  };
  render(<MeetingSetup {...props} />);
  return props;
}

describe("participant count", () => {
  it("offers a choice from one up to the maximum", () => {
    setup();
    for (const count of [1, 2, MAX_SPEAKERS]) {
      expect(screen.getByRole("button", { name: String(count) })).toBeInTheDocument();
    }
  });

  it("defaults to two", () => {
    setup();
    expect(screen.getByRole("button", { name: "2" })).toHaveAttribute("aria-pressed", "true");
  });

  it("passes the chosen count when starting", async () => {
    const { onStart } = setup();

    await userEvent.click(screen.getByRole("button", { name: "4" }));
    await userEvent.click(screen.getByRole("button", { name: /start recording/i }));

    expect(onStart).toHaveBeenCalledWith({ title: "Untitled meeting", speakerCount: 4 });
  });

  it("marks only one count as selected at a time", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "5" }));

    expect(screen.getByRole("button", { name: "5" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "2" })).toHaveAttribute("aria-pressed", "false");
  });

  it("explains why the number matters, rather than just asking for it", () => {
    setup();
    expect(screen.getByText(/not by voice|pauses in the audio/i)).toBeInTheDocument();
    expect(screen.getByText(/sharing a label/i)).toBeInTheDocument();
  });
});

describe("title", () => {
  it("passes a trimmed title", async () => {
    const { onStart } = setup();

    await userEvent.type(screen.getByLabelText(/meeting title/i), "  Billing sync  ");
    await userEvent.click(screen.getByRole("button", { name: /start recording/i }));

    expect(onStart).toHaveBeenCalledWith({ title: "Billing sync", speakerCount: 2 });
  });

  it("falls back to a default when left blank", async () => {
    const { onStart } = setup();
    await userEvent.click(screen.getByRole("button", { name: /start recording/i }));

    expect(onStart).toHaveBeenCalledWith({ title: "Untitled meeting", speakerCount: 2 });
  });
});

describe("sample meeting", () => {
  it("offers a sample that needs no microphone", async () => {
    const { onStartSample } = setup();

    await userEvent.click(screen.getByRole("button", { name: /sample meeting/i }));
    expect(onStartSample).toHaveBeenCalled();
  });

  it("says what the sample is and credits the source", () => {
    setup();
    expect(screen.getByText(/no\s+microphone needed/i)).toBeInTheDocument();
    expect(screen.getByText(/public domain/i)).toBeInTheDocument();
  });
});

describe("gating", () => {
  it("cannot start before the server connection is up", () => {
    setup({ canStart: false });

    expect(screen.getByRole("button", { name: /start recording/i })).toBeDisabled();
    expect(screen.getByText(/waiting for the server/i)).toBeInTheDocument();
  });

  it("shows a loading state and locks the form while starting", () => {
    setup({ busy: true });

    expect(screen.getByRole("button", { name: /starting/i })).toBeDisabled();
    expect(screen.getByLabelText(/meeting title/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: "4" })).toBeDisabled();
  });

  it("does not start twice if submitted while busy", async () => {
    const { onStart } = setup({ busy: true });
    await userEvent.click(screen.getByRole("button", { name: /starting/i }));
    expect(onStart).not.toHaveBeenCalled();
  });
});
