# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The AGENTS.md block above is auto-written by `next dev` — leave it in place. Its instruction is real: this repo runs **Next.js 16.3.5**, which breaks with older Next.js. Before writing framework-touching code, consult `node_modules/next/dist/docs/` — especially `01-app/02-guides/upgrading/version-16.md`. Highlights:

- Request APIs are async: `params`, `searchParams`, `cookies()`, `headers()` return Promises — await them.
- Route components use generated typed props (`LayoutProps<"/">`, `PageProps<"...">`) — globals from `next-env.d.ts`, no import.
- `middleware.ts` is renamed `proxy.ts`. Turbopack is the default bundler.
- New caching APIs: `updateTag`, `refresh`, `cacheLife`/`cacheTag`.

## What this is

Self-hosted internship tracking + ranking app for a single user (UGA CS student applying to Summer 2027 SWE internships). Ingests listings from multiple sources on a schedule, dedups them, scores them 0–100 against the user's profile, tracks application status, sends alerts, and shows resume↔posting keyword matches. **Explicitly out of scope: auto-apply, form filling, storing credentials for job sites.**

> **This file describes what is built, not what is planned.** All five phases
> are done. Anything not yet built is called out as such, here and in
> `docs/ARCHITECTURE.md`; if you find a claim here that the code does not
> support, the file is wrong — fix it rather than building to match it.
> **Written but never executed: the container images have never been built and
> the stack has never run under Docker** (see `docs/DEPLOYMENT.md`, which opens
> with that caveat and ends with a first-deploy checklist).

## Stack & commands

Next.js 16 App Router + TypeScript + React 19 + Tailwind v4 (CSS-based config in `app/globals.css`, no tailwind.config) · Prisma + Postgres · separate worker container (node-cron) · Deployed as services appended to a host Docker stack behind Traefik · Authelia forward-auth via a Traefik middleware (single user, config in env).

- `npm run dev` — dev server at localhost:3000
- `npm run build` / `npm start` — production build/serve
- `npm run lint` — ESLint 9 flat config
- `npx vitest run` — all tests; `npx vitest run tests/scoring/engine.test.ts` — one file
- `npx prisma migrate dev` — create/apply a migration locally; `npx prisma studio` — inspect DB

Tests are Vitest, fixture-driven (`tests/fixtures/`), and never touch the network.

`DATABASE_URL` must name its schema explicitly (`?schema=public` in development). `prisma dev`'s proxy leaks `search_path` between connections, so a URL without `?schema=` can silently read and write the *test* schema — which looks like "the column doesn't exist" in the app while `prisma db push` insists it already does. Always pass `--url` with the schema when pushing by hand.

`*.integration.test.ts` files use a real database and wipe tables in `beforeEach`, so they run against a dedicated Postgres **schema** (`itest`), created by `tests/global-setup.ts` and selected by `tests/setup-env.ts`. Two traps are already handled here — don't undo them: (1) `prisma dev`'s local proxy ignores the *database* name in a connection string and routes every name to one physical database, so separate-database isolation silently fails; (2) with Prisma 7 driver adapters, `?schema=` is passed to node-postgres, which ignores unknown parameters, so `lib/db.ts` must read that parameter and hand it to `PrismaPg` explicitly. Vitest also runs test files sequentially (`fileParallelism: false`) since they share the one test schema.

## Layout

**`docs/ARCHITECTURE.md` is the accurate map** — data flow, ER diagram, model
invariants, rescoring triggers, the `prisma dev` schema trap, and where every
knob lives. Read it before changing the pipeline, scoring, or the schema. It
ends with a plan-vs-reality table listing what the original plan describes but
isn't built yet.

```
proxy.ts                # the auth gate — runs on everything but /api/health
app/
  listings/             # / table, detail panel, context menu, merge-split
  tracker/              # /tracker kanban/list + dashboard
  import/               # /import paste/CSV import
  resume/               # /resume PDF upload (text extracted once, at upload)
  alerts/               # /alerts thresholds + per-kind "Send now"
  api/health/           # unauthenticated liveness probe for the healthcheck
  api/applications/export/  # GET applications CSV (checks the session itself)
lib/
  auth.ts               # identity from Authelia's forward-auth headers
  auth-guard.ts         # requireSession() — called by every Server Action
  db.ts                 # Prisma client singleton (passes ?schema= to the adapter)
  cycle.ts              # one full refresh: ingest → score → detail → score+LLM
  ingestion/            # adapters/, detail/, normalize, dedupe, pipeline
    merge-audit.ts      # reads Listing.mergedFrom — kept out of split.ts so the
                        #   read models don't pull the pipeline into their graph
    split.ts            # undo ONE merge: rebuild the listing from ListingSource.raw
  scoring/              # config, engine (pure), llm, rescore (+ ranks)
  listings/             # table + detail read models, row mutations
  applications/         # import parse/match, commit, tracker, CSV
  resume/               # extract (unpdf), store, keyword vocabulary + matching
  alerts/               # settings/config, build (pure), data, send, channels/
worker/index.ts         # node-cron: ingest cycle, digest, closing-soon; /refresh, /healthz
prisma/schema.prisma
config/scoring.json     # ALL weights/keywords/tiers/thresholds — no restart needed
tests/                  # mirrors lib/; fixtures/ holds real captured payloads
Dockerfile              # ONE runtime image; app and worker differ by command
docker/entrypoint.sh    # migrate deploy when RUN_MIGRATIONS=1, then exec
deploy/compose.tracker.yml   # services to APPEND to the host stack's compose.yml
deploy/env.tracker.example   # TRACKER_* vars to append to the host stack's .env
scripts/backup.sh, restore.sh, backup-healthcheck.sh
docs/ARCHITECTURE.md, docs/DEPLOYMENT.md
```

## Architecture decisions (settled — don't relitigate)

- **Sources are pluggable adapters.** Each implements `SourceAdapter` returning Zod-validated `NormalizedListing[]`. Adding a source = one adapter file + one registry entry — `source` is a plain string, not a DB enum, so no migration either. One adapter's failure never aborts the pipeline.
- **Simplify adapter reads JSON, not the README.** `.github/scripts/listings.json` on the `dev` branch (schema documented in `.claude/agents/ingestion-agent.md`). The FAANG+ 🔥 flag exists only in the README, so a light second pass extracts just the 🔥 company set. README table parsing is the fallback only.
- **Ingestion has a third stage: posting-detail fetch.** After dedup and a provisional stage-1 score, listings clearing a configurable threshold get their posting page fetched for description text and application deadline — dedicated parsers for Greenhouse/Lever/Ashby/Workday, generic text extraction otherwise; rate-limited, robots-aware, URL-deduped within a run. `detailFetchedAt`/`detailFetchStatus`/`atsKind` on Listing make silent parser failures visible. Re-fetch only when the source record changes or the fetch exceeds a configurable age.
- **Dedup**: exact match on `dedupKey` (normalized company|title|location bucket — indexed, NOT unique), then fuzzy title match within company+location. Hard guard that overrides any fuzzy match: records whose `requisitionId` or canonical URL differ are NEVER merged — a wrong merge silently hides a real role, so bias toward not merging when uncertain. **URL identity is host + path + query**: an ATS embedded in a company's careers page puts the job id in the query (`?gh_jid=`), so comparing paths alone once merged three distinct EquipmentShare requisitions into one row. `extractRequisitionId` reads `gh_jid` on any host for the same reason. Every merge is recorded in `Listing.mergedFrom`. **Splitting a wrong merge back apart is built** (`lib/ingestion/split.ts` + the row-action registry): the source record is re-normalized from its verbatim `ListingSource.raw` through the same adapter mapping that produced it, so the recovered listing is the one the pipeline would have created. Listings gone from all sources become `likelyClosed` — rows are never deleted.
- **User flags on Listing**: `saved` (watching; drives closing-soon alerts) and `dismissed` (cleared from the main table and stays cleared across refreshes).
- **Raw fetches persist** gzipped on `IngestRun` rows before parsing (diffable, debuggable), pruned after `RAW_RETENTION_DAYS`.
- **Scoring is two-stage**: stage 1 pure/deterministic from `config/scoring.json` (read and hashed on every scoring run — editing weights needs no restart; the file is volume-mounted into both containers at `config/scoring.json`); stage 2 optional Claude pass for high scorers, clamped ±15, cached in `LlmAssessment` by posting-text hash, and **skipped entirely when `postingText` is null** — never pay for a call that only sees a title. Disqualifiers zero the score but keep the breakdown; hiding them is a UI concern.
- **Stage 2 runs at `temperature: 0`** (`llm.temperature` in the config). The result is cached forever against the posting-text hash, so the first roll is the score that listing keeps; at the API default, four identical calls on one posting spread 10 points on a ±15 scale. The structured-output schema must **not** carry `minimum`/`maximum` on the integer — the Messages API 400s on them, which silently failed every stage-2 call. The ±15 bound is enforced by `clampAdjustment`, never by the schema.
- **Rank movement is reported only when the listing's own score moved.** `recomputeRanks` stamps `Listing.scoreMoved` in the same statement as `previousRank` (so it stays paired with the move it describes) and rolls `previousScore` forward afterwards. Nearly every rank change is a cascade — 1,425 of 1,615 ranked listings carried one while sitting still — so the table's ↑/↓ is gated on this flag.
- **The full cycle is ordered** (`lib/cycle.ts`): ingest → provisional stage-1 score → posting-detail fetch for listings clearing `thresholds.detailFetchMin` → final stage-1 rescore → stage-2 LLM. The provisional pass exists because most sources ship no description text: a cheap score over title/category/company/location decides which posting pages are worth fetching, rather than fetching thousands. **Newly fetched posting text or a new deadline sets `scoringConfigHash = null`**, which is how a listing marks its own score stale — the final pass then picks up exactly those rows with no extra bookkeeping.
- **Worker vs app**: worker (node-cron) owns the scheduled cycle (ingestion + rescoring) and the scheduled alerts — HIGH_SCORE after each cycle, `DIGEST_CRON` and `CLOSING_SOON_CRON` on their own schedules. Every pattern goes through `cron.validate` first, so a typo disables one job instead of killing the container at boot, and an alert failure can never abort a cycle. **Backups are not built.** "Refresh now" is meant to be the app calling the worker's `POST /refresh` on the internal network (never exposed via Traefik) — the endpoint exists, but **no UI calls it yet**.
- **Alerts record `AlertLog` only after a successful send.** Recording first would dedupe a failed alert away permanently; a failure on one channel must not stop the other. Every alert kind is manually triggerable from `/alerts` through the same code path the cron uses. Thresholds live in the `Setting` table (UI-editable); scoring weights never do.
- **"Not Applied" is either no Application row, or a row with status `NOT_APPLIED` that exists only to hold notes written before applying.** Status changes never delete user notes: un-applying a listing whose application has notes keeps the row. Readers treat both the same (the table folds null into NOT_APPLIED; the tracker and dashboard exclude NOT_APPLIED rows). `Application.listingId` is optional: manual entries (own `companyName`/`roleTitle`/`location`) are first-class for roles found outside the sources — bulk imports mostly won't match a listing — and can later be linked to one while keeping their fields. Status history lives in `StatusEvent`.
- **Auth is Authelia forward-auth, and the network is part of it.** Authelia authenticates every request as a Traefik middleware and forwards `Remote-Email`/`Remote-User`; the app reads those and checks them against `ALLOWED_USER`. There is no login flow, no session and no `/signin` page here — Authelia owns all of that. **These headers are trusted, which is only safe because nothing but Traefik can reach the container**: `deploy/compose.tracker.yml` keeps the app on `traefik_net` + an internal `tracker_net` and off the shared `apps_net`. Putting it back on a shared network, or publishing its port, hands anyone who can reach it a valid login. Do not do either.
- **Two layers all the same.** `proxy.ts` gates every path but `/api/health`; **separately**, every Server Action calls `requireSession()` as its first statement and `/api/applications/export` checks too. The proxy runs outside render, so a matcher mistake should cost a 401, not the catalog. `tests/auth/guard.test.ts` **discovers** `app/**/actions.ts` rather than listing them, so a new unguarded action fails the suite by existing — verified by planting one.
- **The allowlist fails closed.** An unset or blank `ALLOWED_USER` admits *nobody*. Authelia's own access control is usually broader than this app wants (a `default_policy` covering every domain admits every user), so this is the narrowing step, not a duplicate of it. `isPublicPath` matches exactly, never by prefix.
- **`public/` is deliberately NOT excluded from the proxy matcher**, and neither is `_next/image`. Files there would otherwise be served to anonymous callers, and a resume lives at `public/resume.pdf`.
- **All external data is untrusted**: source payloads, CSV imports, PDF text, and LLM responses all pass Zod validation at the boundary; scraped text is sanitized before rendering.

## Subagents

`.claude/agents/` defines specialists — ingestion-agent, scoring-agent, frontend-agent, devops-agent, reviewer-agent. Use them for work in their domains; run independent work in parallel. reviewer-agent reviews each phase's diff before it is presented to the user.

## Build phases (stop for user review after each)

1. ✅ Schema + ingestion (adapters, dedup, worker, fixtures + tests)
2. ✅ Scoring engine + tests
3. ✅ UI + application tracker
4. ✅ Alerts + resume matching (+ merge-split)
5. ✅ Auth + deployment (Docker, compose, Traefik, backups) — **written, never
   deployed**. Targets the hp-envy host stack at `~/docker/stacks/apps/`;
   Authelia forward-auth, no OIDC client and no `configuration.yml` changes.
   See the ordered checklist in `docs/DEPLOYMENT.md`

Secrets/config: every env var documented in `.env.example`; real values only in gitignored `.env*`.
