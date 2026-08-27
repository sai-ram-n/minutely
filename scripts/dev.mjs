#!/usr/bin/env node
/**
 * Runs the API and the client together with prefixed, colour-coded output.
 *
 * Deliberately dependency-free — a task runner is not worth adding for this.
 *
 *     npm run dev:all
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reads PORT out of server/.env.
 *
 * The server takes its port from there, but Vite's proxy needs the same value —
 * and Vite does not read that file. Without this the two disagree the moment
 * anyone changes PORT, and the symptom is an app that loads but whose every API
 * call fails, which is a horrible thing to debug.
 *
 * @returns {string}
 */
function serverPort() {
  if (process.env.PORT) return process.env.PORT;

  const envFile = resolve(ROOT, "server", ".env");
  if (existsSync(envFile)) {
    const match = /^\s*PORT\s*=\s*(\d+)/m.exec(readFileSync(envFile, "utf8"));
    if (match) return match[1];
  }

  return "3001";
}

const PORT = serverPort();

const COLOURS = { api: "\x1b[36m", web: "\x1b[35m", reset: "\x1b[0m", dim: "\x1b[2m" };

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let shuttingDown = false;

/**
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
function run(label, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    // Both halves get the same PORT, so the client's proxy and the server's
    // listener can never drift apart.
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const prefix = `${COLOURS[label]}${label.padEnd(3)}${COLOURS.reset} ${COLOURS.dim}|${COLOURS.reset} `;

  const forward = (stream, target) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        target.write(`${prefix}${line}\n`);
        // Vite picks the next free port when the preferred one is taken, so the
        // only trustworthy url is the one it reports. Announce that, rather
        // than the port we asked for.
        if (label === "web") announceUrl(line);
      }
    });
  };

  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on("exit", (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    // If either half dies the pair is useless; stop cleanly rather than
    // leaving a half-running setup that looks fine until you use it.
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

let announced = false;

/**
 * Reprints the address to open, using the port Vite actually bound.
 * @param {string} line
 */
function announceUrl(line) {
  if (announced) return;

  const match = /Local:\s+(https?:\/\/\S+?)\/?\s*$/.exec(line.replace(/\x1b\[[0-9;]*m/g, ""));
  if (!match) return;
  announced = true;

  const actualPort = new URL(match[1]).port;
  const lan = lanAddress();
  const bar = "─".repeat(58);

  process.stdout.write(`
  ${bar}

    Open this:   https://localhost:${actualPort}
${lan ? `    Or:          https://${lan}:${actualPort}\n` : ""}
    Self-signed certificate — the browser warns once.
    Click "Advanced", then "Proceed". That is what makes the
    microphone work.

  ${bar}

`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/** First non-internal IPv4 address, i.e. the one another machine can reach. */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

console.log(`
  Minutely — starting the API and the client.
  The address to open is printed below once the client is ready.
  API on port ${PORT}. Press Ctrl+C to stop everything.
`);

run("api", "npm", ["run", "dev", "--workspace", "server"], ROOT);
run("web", "npm", ["run", "dev", "--workspace", "client"], ROOT);
