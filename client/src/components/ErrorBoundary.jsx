/**
 * Catches render-time crashes so a bug in one screen shows a recoverable
 * message instead of a blank white page — the worst possible thing to happen
 * during a live demo.
 */

import { Component } from "react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept in the console so the detail is recoverable without exposing a
    // stack trace in the UI.
    console.error("Minutely crashed while rendering:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="card" role="alert">
        <h2>Something went wrong</h2>
        <p className="muted">
          This screen hit an unexpected error. Your recorded meetings are safe —
          they are stored on the server, not in this page.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => globalThis.location.reload()}
          >
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
