#!/usr/bin/env node
/**
 * Single source of truth propagation.
 *
 * `version.json` at the repo root is the ONLY place name/version/releaseDate are
 * hand-edited. This script pushes those values everywhere else that needs them:
 *
 *   - root/client/server package.json  -> name + version fields
 *   - client/src/version.json          -> verbatim copy (Vite cannot import from
 *                                         outside its own root, so the client gets
 *                                         a synced copy rather than a live read)
 *
 * The server does NOT get a copy: it reads version.json directly at runtime via
 * fs.readFileSync, so there is nothing to sync there.
 *
 * Runs automatically on predev/prebuild. Safe to run by hand at any time.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** npm package names must be lowercase and URL-safe; the display name need not be. */
function toPackageName(displayName) {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-~][^a-z0-9-._~]*/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fail(message) {
  console.error(`\n  sync-version: ${message}\n`);
  process.exit(1);
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`${label} not found at ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${label} at ${path} is not valid JSON — ${err.message}`);
  }
}

// ---- 1. Read and validate the source of truth ------------------------------

const versionPath = join(ROOT, "version.json");
const source = readJson(versionPath, "version.json");

for (const field of ["name", "version", "releaseDate"]) {
  if (typeof source[field] !== "string" || source[field].trim() === "") {
    fail(`version.json is missing a non-empty string "${field}"`);
  }
}
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(source.version)) {
  fail(`version.json "version" must be semver (e.g. 1.0.0), got "${source.version}"`);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(source.releaseDate)) {
  fail(`version.json "releaseDate" must be YYYY-MM-DD, got "${source.releaseDate}"`);
}

const basePackageName = toPackageName(source.name);
if (!basePackageName) fail(`version.json "name" does not reduce to a valid npm package name`);

// ---- 2. Propagate into the three package.json files ------------------------

/** @type {{ path: string, name: string }[]} */
const targets = [
  { path: join(ROOT, "package.json"), name: basePackageName },
  { path: join(ROOT, "client", "package.json"), name: `${basePackageName}-client` },
  { path: join(ROOT, "server", "package.json"), name: `${basePackageName}-server` },
];

const changes = [];

for (const target of targets) {
  if (!existsSync(target.path)) {
    console.warn(`  sync-version: skipping ${target.path} (does not exist yet)`);
    continue;
  }
  const pkg = readJson(target.path, "package.json");
  const before = { name: pkg.name, version: pkg.version };

  pkg.name = target.name;
  pkg.version = source.version;

  if (before.name !== pkg.name || before.version !== pkg.version) {
    changes.push(`${target.path.replace(ROOT + "/", "")}: ${before.name}@${before.version} -> ${pkg.name}@${pkg.version}`);
  }
  writeFileSync(target.path, JSON.stringify(pkg, null, 2) + "\n");
}

// ---- 3. Copy verbatim into the client ---------------------------------------

const clientCopyDir = join(ROOT, "client", "src");
if (!existsSync(clientCopyDir)) mkdirSync(clientCopyDir, { recursive: true });
const clientCopyPath = join(clientCopyDir, "version.json");
writeFileSync(clientCopyPath, JSON.stringify(source, null, 2) + "\n");

// ---- 4. Report ---------------------------------------------------------------

console.log(`  sync-version: ${source.name} v${source.version} (${source.releaseDate})`);
for (const change of changes) console.log(`    updated ${change}`);
console.log(`    wrote   client/src/version.json`);
