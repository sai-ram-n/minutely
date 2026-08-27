#!/usr/bin/env node
/**
 * Runs the API and the client together with prefixed, colour-coded output.
 *
 * Deliberately dependency-free — a task runner is not worth adding for this.
 *
 *     npm run dev:all
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    env: process.env,
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
      for (const line of lines) target.write(`${prefix}${line}\n`);
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

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`
  Minutely — local development

    api  http://localhost:${process.env.PORT ?? 3001}
    web  http://localhost:5173  (Vite picks the next free port if taken)

  Press Ctrl+C to stop both.
`);

run("api", "npm", ["run", "dev", "--workspace", "server"], ROOT);
run("web", "npm", ["run", "dev", "--workspace", "client"], ROOT);
