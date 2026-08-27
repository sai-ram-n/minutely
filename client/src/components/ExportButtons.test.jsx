/**
 * Export buttons.
 *
 * Downloads go through fetch rather than a plain link specifically so failures
 * are visible, so the failure paths are what matter here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportButtons } from "./ExportButtons.jsx";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

let clicked;
let createdUrls;

beforeEach(() => {
  clicked = [];
  createdUrls = 0;

  globalThis.URL.createObjectURL = vi.fn(() => {
    createdUrls += 1;
    return `blob:mock-${createdUrls}`;
  });
  globalThis.URL.revokeObjectURL = vi.fn();

  // Capture the synthesised download click instead of navigating.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click() {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function okResponse(filename, body = "content", type = "text/markdown") {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-disposition"
          ? `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
          : null,
    },
    blob: async () => new Blob([body], { type }),
  };
}

describe("ExportButtons", () => {
  it("renders both export options", () => {
    render(<ExportButtons meetingId={MEETING_ID} />);

    expect(screen.getByRole("button", { name: /export pdf/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export markdown/i })).toBeInTheDocument();
  });

  it("downloads Markdown with the server's filename", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okResponse("Billing-sync-2026-08-27.md"));

    render(<ExportButtons meetingId={MEETING_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /export markdown/i }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe("Billing-sync-2026-08-27.md");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/meetings/${MEETING_ID}/export.md`),
    );
  });

  it("downloads PDF from the .pdf endpoint", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okResponse("Billing-sync-2026-08-27.pdf", "%PDF-", "application/pdf"));

    render(<ExportButtons meetingId={MEETING_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /export pdf/i }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("export.pdf"));
  });

  it("prefers the UTF-8 filename when the two differ", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: () => `attachment; filename="Caf_ review.md"; filename*=UTF-8''${encodeURIComponent("Café review.md")}`,
      },
      blob: async () => new Blob(["x"]),
    });

    render(<ExportButtons meetingId={MEETING_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /export markdown/i }));

    await waitFor(() => expect(clicked[0].download).toBe("Café review.md"));
  });

  it("shows a loading state while generating", async () => {
    let resolveFetch;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));

    render(<ExportButtons meetingId={MEETING_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /export pdf/i }));

    // The spinner adds a screen-reader label, so match the button itself
    // rather than any element whose text contains "generating".
    const pdfButton = await screen.findByRole("button", { name: /generating pdf/i });
    expect(pdfButton).toBeDisabled();
    expect(pdfButton).toHaveTextContent(/generating/i);

    // Both buttons lock so a second export cannot be started mid-flight.
    expect(screen.getByRole("button", { name: /export markdown/i })).toBeDisabled();

    resolveFetch(okResponse("x.pdf"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /export pdf/i })).toBeEnabled(),
    );
  });

  it("surfaces the server's error message instead of navigating away", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: async () => ({ error: "Meeting not found" }),
    });

    render(<ExportButtons meetingId={MEETING_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /export pdf/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/meeting not found/i);
    expect(clicked).toHaveLength(0);
  });

  it("handles a non-JSON error body without crashing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => {
        throw new Error("not json");
      },
    });

    render(<ExportButtons meetingId={MEETING_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /export markdown/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/500/);
  });

  it("explains an unreachable server rather than showing a raw fetch error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    render(<ExportButtons meetingId={MEETING_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /export pdf/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/waking up/i);
  });

  it("recovers after a failure", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(okResponse("ok.md"));

    render(<ExportButtons meetingId={MEETING_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /export markdown/i }));
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: /export markdown/i }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is disabled while a meeting is still recording", () => {
    render(<ExportButtons meetingId={MEETING_ID} disabled />);

    expect(screen.getByRole("button", { name: /export pdf/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /export markdown/i })).toBeDisabled();
  });
});
