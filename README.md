# Minutely

Live meeting transcription and structured minutes of meeting. Record from your
browser, watch the transcript appear as you speak, and get decisions, action
items and open questions generated automatically when you stop.

Built entirely on services with genuine ongoing free tiers — no credit card, no
time-limited trials.

---

## Status

Phase 7 of 10 complete. Phase 8 (deploy) is ready to run — see [Deploying](#deploying).

## Requirements

- **Node 22+** (`.nvmrc` is provided — `nvm use`)
- A **Groq API key** — free, no card, from [console.groq.com](https://console.groq.com)

## Local setup

```bash
nvm use
npm install
cp .env.example server/.env    # then paste your GROQ_API_KEY into it
npm run dev
```

The server starts on `http://localhost:3001`. No cloud setup is needed for local
development: the database is a local SQLite file (`server/local.db`), created and
migrated automatically on first boot.

### Useful scripts

| Command | What it does |
|---|---|
| `npm run dev` | Sync version, then start the server with file watching |
| `npm test` | Run all tests across client and server |
| `npm run lint` | Lint everything |
| `npm run sync-version` | Propagate `version.json` everywhere it is used |
| `npm run migrate` | Apply database migrations (idempotent) |
| `node scripts/verify-provider.mjs` | Live check against the real Groq API (spends quota, needs network) |
| `node scripts/verify-socket.mjs` | End-to-end socket check against a running server (spends quota) |
| `node scripts/verify-turns.mjs` | Turn-detection check against real two-turn audio (spends quota) |
| `node scripts/verify-minutes.mjs` | Full record → stop → minutes check (spends quota) |

## Versioning — one file, one edit

`version.json` at the repo root is the **only** place name, version and release
date are hand-edited:

```json
{ "name": "Minutely", "version": "1.0.0", "releaseDate": "2026-08-27" }
```

`scripts/sync-version.mjs` runs automatically on `predev`/`prebuild` and pushes
those values into the root, `client/` and `server/` `package.json` files, plus a
synced copy at `client/src/version.json` (Vite cannot import from outside its own
root). The server reads `version.json` directly at runtime and serves it from
`GET /api/version`.

The client compares its synced copy against `/api/version` on load and logs a
console warning if they differ — this catches shipping the frontend without the
matching backend.

**To cut a release:** edit `version.json`, run `npm run sync-version`, redeploy
both sides.

## Configuration

All server configuration is validated with zod at startup. **The server exits
immediately with a readable message if anything required is missing or
malformed** — it never starts into a half-working state.

See [.env.example](.env.example) for the full list. Required: `GROQ_API_KEY`.
Everything else has a sensible local default.

Production additionally requires a remote `libsql://` database URL and a real
frontend origin — a local SQLite file would be wiped by the host's ephemeral
filesystem, and a `localhost` CORS origin would reject your own deployed site.
Both are enforced at boot.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness **and** database reachability. Exempt from rate limiting — use it to wake a sleeping host. |
| `GET /api/version` | `{ name, version, releaseDate }` from `version.json` |
| `GET /api/meetings/:id/speakers` | Distinct speaker labels, in first-spoken order |
| `PATCH /api/meetings/:id/speakers` | Rename a speaker: `{ from, to }` |
| `GET /api/meetings` | Meeting history, newest first |
| `GET /api/meetings/:id` | One meeting with its transcript and minutes |
| `GET /api/meetings/:id/minutes` | Generated minutes, if any exist yet |
| `POST /api/meetings/:id/summarize` | Generate or retry minutes from the stored transcript |
| `GET /api/meetings/:id/export.md` | Markdown export (UTF-8, lossless) |
| `GET /api/meetings/:id/export.pdf` | PDF export |

### WebSocket (`/ws`)

```
client -> server   { type: "start_recording", title }
server -> client   { type: "recording_started", meetingId }

client -> server   { type: "audio_chunk", meetingId, data: <base64>, sequence }
server -> client   { type: "transcript_line", speakerLabel, text, timestamp, sequence }
server -> client   { type: "transcription_error", message, sequence, retryable }

client -> server   { type: "stop_recording", meetingId }
server -> client   { type: "recording_stopped", meetingId }
server -> client   { type: "processing" }
server -> client   { type: "mom_ready", meetingId }
server -> client   { type: "mom_failed", meetingId, message }

client -> server   { type: "resume_recording", meetingId, lastSequence }
server -> client   { type: "resumed", meetingId, lines }
```

Every inbound message is validated with zod before any handler touches it, so a
malformed payload becomes an error reply rather than a crashed server.

### Export, and one real PDF limitation

Both formats are built from the same content and stamped
`Generated by Minutely v1.0.0 · 2026-08-27`, from the same `version.json`
everything else derives from.

**Markdown is UTF-8 and lossless.** Reach for it when a transcript contains
scripts beyond Latin-1.

**PDF cannot render every script.** pdfkit's built-in fonts use WinAnsi
encoding, and characters outside it are not rejected — they are silently drawn
as mojibake (`साई राम` comes out as garbage punctuation). Shipping a corrupted
document with no warning is worse than degrading visibly, so unsupported
characters are replaced with `¿` and the PDF itself carries a note saying how
many were replaced and to use the Markdown export for the complete text.

Fixing this properly means embedding a Unicode font. No single font covers
Devanagari *and* CJK at a sane size, so it is a deliberate v1 trade-off rather
than an oversight.

### UI states

Every async surface renders three states explicitly — loading, error with a
retry affordance, and a real empty state. There is no path that shows blank
space or an indefinite spinner. An `ErrorBoundary` wraps each screen and is
keyed by route, so a crash in one screen cannot strand another, and the page
never goes white.

Routing is hash-based, so the browser back button works and a meeting URL can
be shared without adding a router dependency.

### CORS in development

Production accepts exactly `FRONTEND_ORIGIN` and nothing else. Development also
accepts any `localhost` port, because Vite silently picks a different port when
its default is taken — pinning the allowlist to one port turns that into a
WebSocket handshake 403 with no obvious cause.

### Why a meeting is never stuck in "processing"

Every path through `summarizeMeeting()` leaves a meeting either `done` or
`failed` — a meeting sitting in `processing` forever is an invisible dead end,
so it is treated as a bug rather than a state.

Failures also carry whether retrying can actually help. A rate limit or a
transient provider error is retryable, so the UI offers a retry and
`POST /api/meetings/:id/summarize` regenerates from the stored transcript at the
cost of one API call — no re-recording. An **empty transcript is not
retryable**: nothing was captured, and a retry button there would be a dead end
dressed up as an action, so the specific reason is shown instead.

### How turn detection works

Timings come from Whisper's `verbose_json` segments. Because those times are
relative to each audio chunk, every segment is offset by its chunk's position in
the meeting — without that, a pause spanning a chunk boundary would be invisible,
which is the most likely place for a real speaker change to occur.

`detectTurns()` in `server/src/services/turnDetection.js` is a pure function:
state goes in and comes back out, nothing is held in module scope. A single audio
chunk can therefore contain several turns, which is why transcript line sequence
is independent of chunk sequence.

### Why recording is chunked the way it is

`MediaRecorder.start(timeslice)` only puts the container header on the **first**
blob, so later blobs are not independently decodable — a naive implementation
transcribes chunk 1 and then fails on every chunk after it.

Instead each chunk is its own complete recording: the recorder is stopped and a
fresh one started every ~20s. To avoid slicing a word in half at the boundary,
the next recorder starts ~1s *before* the current one stops, so two recorders
briefly overlap. The duplicated words that produces are trimmed server-side by
`dedupeOverlap()`.

## Architecture

```
Browser  ──────────────►  Cloudflare Pages (React build, static)
   │  WebSocket + REST
   ▼
Render free Web Service (Express + ws — sleeps after 15 min idle)
   │
   ├──► Groq Whisper API   (transcription)
   ├──► Groq Llama API     (structured minutes)
   └──► Turso              (SQLite-compatible, hosted — survives restarts)
```

All Groq calls sit behind a small `AiProvider` interface
(`server/src/ai/provider.js`). Retry, backoff and rate-limit handling live
*inside* the provider, not scattered through route handlers. Swapping to another
provider is one new file matching the same shape plus a config change.

The provider is shape-checked with `assertValidProvider()` once at startup, so a
missing or misspelled method fails at boot rather than mid-meeting.

**Model IDs are configuration, not code.** Groq retired
`llama-3.3-70b-versatile`, which this project originally specified; summarization
now defaults to `openai/gpt-oss-120b`. Override either model with
`GROQ_SUMMARY_MODEL` / `GROQ_TRANSCRIBE_MODEL` without a code change.

### Test fixtures

`server/tests/fixtures/audio/` holds two clips derived from a
[LibriVox](https://librivox.org) recording (public domain):

- `sample-speech.webm` — 25s of speech, for verifying transcription
- `two-turns.webm` — two passages separated by a known 2.0s silence, for
  verifying silence-gap turn detection

## Security

- `GROQ_API_KEY` and Turso credentials live only in server environment variables
  and are never sent to or readable by the client
- CORS is locked to `FRONTEND_ORIGIN` — never `*`
- `helmet` on all responses; `x-powered-by` disabled
- `express-rate-limit` at 100 req/min on `/api`, protecting the shared Groq quota
- Secrets are redacted from logs even if passed in by mistake

## Known limitations

- **No true speaker identification.** No free hosted diarization API exists, so
  turn *changes* are inferred from silence gaps in Whisper's segment timings — a
  pause of 1.5s or more advances the label. This detects that the speaker
  probably changed, never who is talking. Labels cycle through two speakers by
  default, so a three-person meeting will mislabel someone; renaming fixes it,
  and `PATCH /api/meetings/:id/speakers` merges two labels if one person got
  split in two. This limitation is stated in the UI, not just here.
- **Mic input only** — no Zoom/Meet tab audio capture.
- **No transcript editing** after the fact (renaming speakers is fine).
- **No accounts** — single-user tool.
- **The free backend sleeps** after 15 minutes idle; the next request takes
  30–60s to wake it. See the demo-day checklist.

## Deploying

Three services, none of which need a credit card. Do them in this order — Turso
first, because the backend cannot start without it.

### 1. Turso (database)

Sign in at [turso.tech](https://turso.tech) with GitHub, create a database, and
copy two values:

- `TURSO_DATABASE_URL` — the `libsql://...` URL
- `TURSO_AUTH_TOKEN`

The schema creates itself on first boot; there is nothing to run by hand.

### 2. Render (backend)

New → Web Service → connect this repo. [render.yaml](render.yaml) already
defines the build, start command, health check and Node version, so the only
thing to do by hand is set the four secret env vars in the dashboard:

| Variable | Value |
|---|---|
| `GROQ_API_KEY` | your Groq key |
| `TURSO_DATABASE_URL` | from step 1 |
| `TURSO_AUTH_TOKEN` | from step 1 |
| `FRONTEND_ORIGIN` | *leave for step 4* |

Note the service URL (e.g. `https://minutely-api.onrender.com`).

The server **refuses to start** in production against a local SQLite file or a
`localhost` CORS origin, so a misconfiguration fails at boot with a readable
message rather than at the first request.

### 3. Cloudflare Pages (frontend)

Create a project from this repo with:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `client/dist` |
| Environment variable | `VITE_API_URL` = your Render URL from step 2 |
| Environment variable | `NODE_VERSION` = `22` |

`VITE_API_URL` is the **only** URL to configure — the WebSocket URL is derived
from it. A production build without it fails deliberately rather than shipping a
frontend that cannot reach its backend.

Note the Pages URL (e.g. `https://minutely.pages.dev`).

### 4. Close the loop

Render needs the Pages URL and Pages needs the Render URL, so one of them is
always set second. Go back to Render, set:

```
FRONTEND_ORIGIN=https://your-project.pages.dev
```

and redeploy. CORS is locked to exactly this value.

### 5. Verify

```bash
curl https://your-service.onrender.com/api/health
curl https://your-service.onrender.com/api/version
```

Then open the Pages URL. The footer version must match `/api/version` — if it
does not, the browser console says so explicitly, which means one half was
deployed without the other.

## Demo-day checklist

1. **Five minutes before going on stage,** visit `/api/health` on the deployed
   backend. This wakes the host so the first real request is not a 30–60s cold
   start in front of an audience.
2. **Do one full dry run end to end** — record, stop, minutes generated, export —
   immediately before presenting.
3. **Have a short pre-recorded backup clip** of a successful run in case live
   audio or network on stage misbehaves. Standard practice for live demos.

## Build order

1. ✅ Server skeleton — env validation, `/api/health`, Turso connection, migrations
2. ✅ `AiProvider` interface + Groq implementation, with retry/backoff and tests
3. ✅ WebSocket plumbing — mic → chunked upload → live transcript
4. ✅ Silence-gap turn detection
5. ✅ Summarization — prompt + structured JSON parsing
6. ✅ UI for all three screens, with loading/error/empty states
7. ✅ PDF/Markdown export, stamped with version and date
8. ⬜ Deploy — Turso, Render, Cloudflare Pages
9. ⬜ CI — lint and test on push
10. ⬜ Full demo-day dry run

## License

MIT — see [LICENSE](LICENSE).
