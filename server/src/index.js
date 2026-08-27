/**
 * Server entry point.
 *
 * Boot order matters: env is validated (and the process exits on failure) before
 * anything else runs, then the schema is migrated, and only then does the server
 * accept traffic. Nothing starts into a half-working state.
 */

import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { createApp } from "./app.js";
import { migrate } from "./services/migrate.js";
import { closeClient, describeTarget } from "./services/db.js";
import { readVersion } from "./config/env.js";
import { getProvider } from "./ai/index.js";
import { attachMeetingSocket } from "./ws/meetingSocket.js";
import { summarizeMeeting } from "./services/summarize.js";

const version = readVersion();

async function main() {
  logger.info(
    { version: version.version, releaseDate: version.releaseDate, env: env.NODE_ENV },
    `${version.name} server starting`,
  );

  try {
    const { applied, skipped } = await migrate({ logger });
    logger.info(
      { target: describeTarget(), applied: applied.length, skipped: skipped.length },
      "database ready",
    );
  } catch (err) {
    logger.fatal({ err: err.message }, "database migration failed — refusing to start");
    process.exit(1);
  }

  // Validate the AI provider's shape before accepting traffic, so a missing or
  // misspelled method surfaces here rather than mid-meeting.
  try {
    getProvider();
  } catch (err) {
    logger.fatal({ err: err.message }, "AI provider is invalid — refusing to start");
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, frontendOrigin: env.FRONTEND_ORIGIN },
      `listening on http://localhost:${env.PORT}`,
    );
  });

  attachMeetingSocket(server, {
    // Wired here rather than inside the socket module so the socket has no
    // opinion about what "finalizing" means and stays testable without it.
    onFinalize: (meetingId) =>
      summarizeMeeting(meetingId, { provider: getProvider() }),
  });

  server.on("error", (err) => {
    logger.fatal({ err: err.message }, "server failed to bind");
    process.exit(1);
  });

  /** @param {string} signal */
  function shutdown(signal) {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      closeClient();
      logger.info("shutdown complete");
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // A crash with no log is the worst possible failure mode; make it loud.
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: String(reason) }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "uncaught exception — exiting");
    process.exit(1);
  });
}

main();
