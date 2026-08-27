/**
 * The error boundary exists so a render crash shows a recoverable message
 * rather than a blank white page — the worst thing that can happen on stage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "./ErrorBoundary.jsx";

function Boom() {
  throw new Error("component exploded");
}

let consoleError;

beforeEach(() => {
  // React logs the caught error; silence it so the suite output stays readable.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("shows a recoverable message instead of a blank page", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload the page/i })).toBeInTheDocument();
  });

  it("reassures the user their meetings are not lost", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/stored on the server/i);
  });

  it("keeps the detail in the console rather than showing a stack trace", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(consoleError).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).not.toMatch(/component exploded/);
  });

  it("recovers when the child no longer throws", async () => {
    function Toggle({ shouldThrow }) {
      if (shouldThrow) throw new Error("still broken");
      return <p>recovered</p>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <Toggle shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <ErrorBoundary>
        <Toggle shouldThrow={false} />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
