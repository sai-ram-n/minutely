/**
 * Application shell: navigation, the three screens, and the footer.
 *
 * Routing is hash-based so the browser back button works and a meeting URL can
 * be shared — worth having, and cheaper than a router dependency.
 */

import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { RecordingScreen } from "./components/RecordingScreen.jsx";
import { MinutesView } from "./components/MinutesView.jsx";
import { MeetingHistory } from "./components/MeetingHistory.jsx";
import { useMeetingSocket } from "./hooks/useMeetingSocket.js";
import { useVersionCheck } from "./hooks/useVersionCheck.js";
import "./styles.css";

/** @returns {{ screen: "record" | "history" | "minutes", meetingId?: string }} */
function parseHash() {
  const hash = globalThis.location?.hash?.replace(/^#\/?/, "") ?? "";
  const [screen, id] = hash.split("/");

  if (screen === "meetings" && id) return { screen: "minutes", meetingId: id };
  if (screen === "meetings") return { screen: "history" };
  return { screen: "record" };
}

export default function App() {
  const [route, setRoute] = useState(parseHash);
  const session = useMeetingSocket();
  const { local, mismatch } = useVersionCheck();

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    globalThis.addEventListener("hashchange", onHashChange);
    return () => globalThis.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((hash) => {
    globalThis.location.hash = hash;
  }, []);

  const openMeeting = useCallback((id) => navigate(`#/meetings/${id}`), [navigate]);

  return (
    <div className="app">
      <header className="header">
        <div className="header__inner">
          <div className="header__brand">
            <span className="header__dot" aria-hidden="true" />
            Minutely
          </div>
          <nav className="nav" aria-label="Main">
            <button
              type="button"
              className={`nav__item ${route.screen === "record" ? "nav__item--active" : ""}`}
              aria-current={route.screen === "record" ? "page" : undefined}
              onClick={() => navigate("#/")}
            >
              Record
            </button>
            <button
              type="button"
              className={`nav__item ${route.screen !== "record" ? "nav__item--active" : ""}`}
              aria-current={route.screen !== "record" ? "page" : undefined}
              onClick={() => navigate("#/meetings")}
            >
              Meetings
            </button>
          </nav>
        </div>
      </header>

      <main className="app__main">
        {mismatch && (
          <div className="banner banner--warn" role="status">
            <div className="banner__body">
              <strong className="banner__title">Version mismatch</strong>
              This page is v{mismatch.client} but the server is v{mismatch.server}. One
              half was deployed without the other.
            </div>
          </div>
        )}

        {/* Remounting per route means one screen's crash cannot strand another. */}
        <ErrorBoundary key={`${route.screen}:${route.meetingId ?? ""}`}>
          {route.screen === "record" && (
            <RecordingScreen session={session} onViewMinutes={openMeeting} />
          )}

          {route.screen === "history" && (
            <MeetingHistory onOpen={openMeeting} onStartRecording={() => navigate("#/")} />
          )}

          {route.screen === "minutes" && route.meetingId && (
            <MinutesView
              meetingId={route.meetingId}
              onBack={() => navigate("#/meetings")}
            />
          )}
        </ErrorBoundary>
      </main>

      <footer className="footer">
        {local.name} v{local.version} · {local.releaseDate}
      </footer>
    </div>
  );
}
