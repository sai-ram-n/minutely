# Meeting minutes AI — production spec (v1)

## Read this first

This is a **v1 product**, not a class project. It doesn't need to serve the whole world, but it needs to survive being demoed live on stage: no crashes on edge cases, no silent failures, no "works on my machine" surprises, no visible placeholder text, no exposed API keys, sensible loading/error states everywhere.

Where a decision below says "assumption," it's a placeholder I picked so the spec isn't blocked — change it freely, it's not load-bearing. Everything else is a real requirement.

**Placeholder product name used throughout this doc: `Minutely`.** Rename it everywhere (package.json, version.json, UI header, README) if you want something else — it's cosmetic and doesn't affect the architecture.

## Every paid-adjacent service, verified

I checked each of these specifically because "free" often means "free trial with a card on file." None of the below require a credit card, and none are time-limited trials. Where a service has a real limitation (not a trial — an ongoing constraint), it's listed so it's designed around, not discovered on stage.

| Service | Role | Free tier | Real limitation |
|---|---|---|---|
| **Groq API** | Whisper transcription + Llama summarization | Ongoing free tier, no card. ~2,000 audio requests/day (~8 hrs), ~14,400 LLM requests/day, 30 req/min | Rate-limited, not usage-capped-then-billed. No commercial SLA — see "provider abstraction" below |
| **Cloudflare Pages** | Frontend static hosting | Ongoing free tier, no card | None significant for a static React build |
| **Render** (free Web Service) | Node/Express + WebSocket backend | Ongoing free tier, no card, 750 instance-hours/month | Spins down after 15 min idle; next request takes ~30–60s to wake up. **Ephemeral filesystem — cannot store SQLite as a local file here.** See demo-day checklist |
| **Turso** | Database (SQLite-compatible, libSQL) | Ongoing free tier, no card, several GB storage | None significant at this scale |
| **GitHub Actions** | CI (lint + test on push) | Free forever for public repos | N/A if repo is public |

**No free tier is contractually "forever."** Any of these could change their policy. That's not unique to free tiers — it's true of any vendor. The mitigation is architectural, not hope: the Groq calls sit behind a small provider interface (see below) so swapping to another provider (Google's Gemini API also has a genuine no-card free tier) is a config change, not a rewrite.

**If you were picturing local SQLite + a single always-on server:** that's what the earlier version of this spec assumed, and it's simpler, but it isn't deployable-with-a-live-link on a free host — free Node hosts with a persistent local disk don't really exist without a card. Turso solves this by being SQLite-compatible but hosted, so the code barely changes.

## Tech stack

- **Frontend:** React + Vite, JavaScript (JSX)
- **Backend:** Node.js + Express, JavaScript, `ws` for WebSocket
- **Database:** Turso (`@libsql/client`) — same client library works against a local file in dev (`file:./local.db`) and the remote Turso database in production (`libsql://...`), so local dev needs zero cloud setup
- **AI:** Groq API — `whisper-large-v3-turbo` for transcription, `llama-3.3-70b-versatile` for summarization
- **Validation:** `zod` — still worth using in plain JS for env vars at startup and the Groq JSON response shape; it catches malformed data at the boundary even without static types
- **Type safety without TypeScript:** add JSDoc `@typedef` blocks for the shapes that matter most (WebSocket messages, the `AiProvider` return shapes, DB rows) and turn on `checkJs` in a `jsconfig.json` — this gets you real editor autocomplete and a lot of TypeScript's day-to-day value with zero build step
- **Logging:** `pino` (server), structured JSON logs
- **Testing:** `vitest` on both client and server
- **Security middleware:** `helmet`, `cors` (locked to the deployed frontend origin), `express-rate-limit` on your own API (protects your Groq quota from being burned by bad actors, not just from your own bugs)
- **Export:** `pdfkit` (PDF), plain string templating (Markdown)
- **License:** MIT (assumption)

## Deployment architecture

```
Browser  ──────────────►  Cloudflare Pages (React build, static, free forever)
   │  WebSocket + REST
   ▼
Render free Web Service (Express + ws, free forever, sleeps after 15 min idle)
   │
   ├──► Groq Whisper API      (transcription)
   ├──► Groq Llama API        (structured minutes)
   └──► Turso                 (SQLite-compatible, hosted, survives Render's sleep/restart)
```

## The version/date file (single source of truth)

Create `version.json` at the repo root:

```json
{
  "name": "Minutely",
  "version": "1.0.0",
  "releaseDate": "2026-08-27"
}
```

This is the **only** place version/date/name are hand-edited. Everything else derives from it:

- `scripts/sync-version.mjs` runs on `predev`/`prebuild` in the root `package.json`. It reads `version.json` and:
  - writes `name`/`version` into the root, `client/`, and `server/` `package.json` files
  - copies `version.json` into `client/src/version.json` (Vite can't reach outside its root, so the client gets its own synced copy rather than a live read)
- The server exposes `GET /api/version`, reading `version.json` directly (plain Node `fs.readFileSync`, no build step needed server-side)
- The client footer shows the version from its synced local copy, and on load also fetches `/api/version` — if they don't match, log a console warning (`"client/server version mismatch — did you forget to redeploy?"`). This catches a real class of deploy bug: shipping the frontend without the matching backend.
- PDF and Markdown exports stamp a footer: `Generated by Minutely v1.0.0 · 2026-08-27`, pulled from the same `version.json` import on the server.

To cut a new release: edit `version.json`, run the sync script, redeploy both sides. One edit, propagates everywhere.

## Folder structure

```
minutely/
├── version.json
├── scripts/
│   └── sync-version.mjs
├── jsconfig.json                    # checkJs: true — editor type-checking from JSDoc, no build step
├── client/                          # React + Vite + JS
│   └── src/
│       ├── components/
│       │   ├── RecordingScreen.jsx
│       │   ├── TranscriptFeed.jsx
│       │   ├── MinutesView.jsx
│       │   ├── MeetingHistory.jsx
│       │   └── ErrorBoundary.jsx
│       ├── hooks/
│       │   └── useMeetingSocket.js
│       ├── version.json             # synced copy, gitignored, regenerated by script
│       └── App.jsx
├── server/                          # Node + Express + JS
│   ├── src/
│   │   ├── index.js
│   │   ├── config/
│   │   │   └── env.js               # zod-validated env vars, fails fast on boot if missing
│   │   ├── ai/
│   │   │   ├── provider.js          # JSDoc @typedef for the AiProvider shape + a runtime shape-check helper
│   │   │   └── groqProvider.js      # Groq implementation of that shape
│   │   ├── services/
│   │   │   ├── transcription.js     # chunking, retry/backoff, calls ai/provider
│   │   │   ├── summarize.js         # prompt construction, calls ai/provider
│   │   │   └── db.js                # Turso client + queries
│   │   ├── routes/
│   │   │   └── meetings.js
│   │   └── ws/
│   │       └── meetingSocket.js
│   └── tests/
│       ├── transcription.test.js
│       ├── summarize.test.js
│       └── retryBackoff.test.js
├── .github/workflows/ci.yml         # lint + test on push, free for public repos
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

## Environment variables

`.env.example` (server):

```
GROQ_API_KEY=your_key_here
TURSO_DATABASE_URL=libsql://your-db.turso.io   # leave unset locally to use file:./local.db
TURSO_AUTH_TOKEN=your_turso_token               # leave unset locally
PORT=3001
FRONTEND_ORIGIN=https://your-app.pages.dev      # used for CORS lock-down
NODE_ENV=production
```

Validate all of these with `zod` at server startup (`server/src/config/env.js`) and **crash immediately with a clear message** if `GROQ_API_KEY` is missing — never let the server start into a broken state and fail confusingly on the first request.

## Data model (Turso / libSQL — same SQL as SQLite)

```sql
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'recording'  -- recording | processing | done | failed
);

CREATE TABLE transcript_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  speaker_label TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  sequence INTEGER NOT NULL
);

CREATE TABLE minutes (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
  decisions TEXT NOT NULL,
  action_items TEXT NOT NULL,
  open_questions TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
```

Add a `status = 'failed'` path: if Groq summarization fails after retries, mark the meeting `failed` rather than leaving it stuck at `processing` forever, and surface that clearly in the UI with a retry button — don't let a failed API call become an invisible dead end.

## AI provider abstraction (important for resilience, not optional)

No TypeScript, so the "interface" is a documented shape plus a runtime check, not a compile-time guarantee — both matter here:

```javascript
// server/src/ai/provider.js

/**
 * @typedef {Object} AiProvider
 * @property {(audioChunk: Buffer) => Promise<{ text: string }>} transcribe
 * @property {(transcript: string) => Promise<{
 *   decisions: string[],
 *   action_items: { task: string, owner: string, due: string }[],
 *   open_questions: string[]
 * }>} summarize
 */

/** @param {AiProvider} provider */
export function assertValidProvider(provider) {
  if (typeof provider.transcribe !== "function" || typeof provider.summarize !== "function") {
    throw new Error("AiProvider implementation missing transcribe() or summarize()");
  }
}
```

`groqProvider.js` implements this shape and is passed through `assertValidProvider()` once at startup — cheap insurance against a typo silently producing a provider with a missing method. Every retry/backoff/rate-limit-handling detail lives inside the provider, not scattered through route handlers. If Groq's policy ever changes, a `geminiProvider.js` matching the same shape is the entire fix — no changes anywhere else in the codebase.

## WebSocket protocol

```
client → server   { type: "start_recording", title }
server → client    { type: "recording_started", meetingId }

client → server   { type: "audio_chunk", meetingId, data: <base64>, sequence }
server → client    { type: "transcript_line", speakerLabel, text, timestamp }
server → client    { type: "transcription_error", message }   // e.g. rate limited — tell the user, don't just drop the chunk silently

client → server   { type: "stop_recording", meetingId }
server → client    { type: "processing" }                     // summarization in flight
server → client    { type: "mom_ready", meetingId }
server → client    { type: "mom_failed", meetingId, message }  // Groq failed after retries
```

Handle client-side reconnection: if the WebSocket drops mid-meeting (real risk on a free host with occasional restarts), the client should attempt to reconnect and resume rather than silently losing the rest of the transcript.

REST:
```
GET  /api/health                   → used to warm the server up before a demo, and by CI
GET  /api/version                  → { name, version, releaseDate }
GET  /api/meetings
GET  /api/meetings/:id
GET  /api/meetings/:id/export.pdf
GET  /api/meetings/:id/export.md
```

## Speaker handling

No free hosted diarization API exists. Detect turn changes via silence gaps between audio chunks (e.g. >1.5s pause = likely new speaker); label generically ("Speaker 1", "Speaker 2"); let the user rename a speaker inline, stored as a simple label override. State this limitation in the UI itself (a small caption under the transcript, not buried in docs) — a product that's honest about its constraints reads as more trustworthy than one that overclaims.

## Rate limits and retries

Groq's free Whisper tier is ~30 req/min. Batch client-side into ~15–20s audio chunks, not per-second. Implement retry with exponential backoff (e.g. 3 attempts, base 1s, doubling) on 429s from Groq, inside `groqProvider.js`, with a matching unit test that mocks a 429 and asserts the retry/backoff behavior — this is exactly the kind of test worth having, since it's the piece most likely to silently break.

## Security checklist

- `GROQ_API_KEY` and Turso credentials live only in server env vars — never sent to or readable by the client
- CORS locked to the deployed frontend origin (`FRONTEND_ORIGIN` env var), not `*`
- `helmet` on the Express app
- `express-rate-limit` on your own REST + WS upgrade endpoints — a free API key behind an unprotected public endpoint is a fast way to exhaust the day's Groq quota
- Validate all incoming WebSocket messages against a schema before touching them (malformed `audio_chunk` payloads shouldn't crash the server)

## Testing requirements

Not full coverage — targeted tests on the parts that are easy to silently break:
- Retry/backoff logic (mock a 429, assert retry count and delay)
- Summarization prompt building (given a transcript, assert the request shape sent to Groq)
- `assertValidProvider()` against both a well-formed and a deliberately broken fake provider, plus a fake provider used to test routes/WS handlers without hitting the real API
- Turn-detection silence-gap logic (given a sequence of chunk timestamps, assert correct speaker-boundary calls)

## UI requirements

Same three screens as before (Recording, Minutes of meeting, Meeting history), with production-level polish now required, not optional:
- Every async action has a visible loading state (recording start, stop/processing, export generation)
- Every failure path has a visible error state with a retry affordance — no silent failures, no infinite spinners
- Empty states are real UI, not blank space (e.g. "No meetings yet — record your first one" on the history screen)
- Version + date shown quietly in the footer (from `client/src/version.json`)

## Demo-day checklist (put this in the README)

1. Visit `/api/health` on the deployed backend 5 minutes before going on stage — this wakes Render up so the first real request isn't a 30–60s cold start in front of an audience
2. Do one full dry-run end to end (record → stop → minutes generated → export) right before presenting
3. Have a short pre-recorded backup clip of a successful run, just in case live audio/network on stage misbehaves — this is standard practice for live demos, not a lack of confidence in the build

## Build order

1. Server skeleton: env validation, `/api/health`, Turso connection (local file first), schema migration
2. `AiProvider` interface + `groqProvider` implementation against saved test audio, with retry/backoff and its unit test, before touching WebSocket at all
3. WebSocket plumbing: browser mic → chunked upload → transcription → live transcript line back, on a bare page
4. Silence-gap turn detection
5. Summarization: prompt + structured JSON parsing against saved transcripts, with its unit test, before wiring to live recordings
6. Real UI for all three screens, with loading/error/empty states from the start, not bolted on after
7. PDF/Markdown export, stamped with version/date
8. Deploy: Turso project, Render service (env vars set), Cloudflare Pages (`FRONTEND_ORIGIN` pointed at it), verify `/api/version` matches on both sides
9. CI: lint + test workflow
10. Full demo-day dry run

## Explicit non-goals for v1

- No user accounts / auth — single-user tool
- No true speaker identification — turn-based labels only
- No remote-call audio capture (Zoom/Meet tab audio) — mic input only
- No transcript text editing after the fact (renaming speakers is fine; editing transcript content is not in scope)

## Notes for whoever builds this

- If a decision isn't covered here (exact spacing, copy wording, minor styling), make a reasonable choice and keep moving
- If you hit a case where meeting the "genuinely free forever" constraint requires a service not listed above, stop and ask rather than substituting a free-trial service — that constraint is non-negotiable per the person who owns this project