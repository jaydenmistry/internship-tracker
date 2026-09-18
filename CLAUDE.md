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

## Stack & commands

Next.js 16 App Router + TypeScript + React 19 + Tailwind v4 (CSS-based config in `app/globals.css`, no tailwind.config) · Prisma + Postgres · separate worker container (node-cron) · Docker Compose behind Traefik via Dokploy · OIDC auth against Authentik (single user, config in env).

- `npm run dev` — dev server at localhost:3000
- `npm run build` / `npm start` — production build/serve
- `npm run lint` — ESLint 9 flat config
- `npx vitest run` — all tests; `npx vitest run tests/scoring/engine.test.ts` — one file
- `npx prisma migrate dev` — create/apply a migration locally; `npx prisma studio` — inspect DB

Tests are Vitest, fixture-driven (`tests/fixtures/`), and never touch the network.

## Layout

```
app/                    # UI + route handlers (auth via proxy.ts)
lib/
  db.ts                 # Prisma client singleton
  ingestion/
    adapters/types.ts   # SourceAdapter interface + NormalizedListing Zod schema
    adapters/*.ts       # one file per source (simplify, intern-list, …)
    detail/             # stage-3 posting-page fetchers (greenhouse, lever, ashby, workday, generic)
    normalize.ts        # company/title/location normalization → dedupKey
    dedupe.ts           # cross-source fuzzy matching
    pipeline.ts         # run adapters, upsert, mark likely-closed
  scoring/
    engine.ts           # stage 1: pure, deterministic, config-driven
    llm.ts              # stage 2: Claude adjustment (±15, cached by text hash)
    config.ts           # loads + hashes config/scoring.json
  alerts/               # discord webhook + SMTP, dedup via AlertLog
  resume/               # PDF text extraction + keyword matching
worker/index.ts         # node-cron schedules + internal HTTP endpoint for "refresh now"
prisma/schema.prisma
config/scoring.json     # ALL weights/keywords/tiers/buckets — editable without redeploy
tests/                  # mirrors lib/ structure; fixtures/ holds real captured payloads
scripts/                # backup.sh etc.
```

## Architecture decisions (settled — don't relitigate)

- **Sources are pluggable adapters.** Each implements `SourceAdapter` returning Zod-validated `NormalizedListing[]`. Adding a source = one adapter file + one registry entry — `source` is a plain string, not a DB enum, so no migration either. One adapter's failure never aborts the pipeline.
- **Simplify adapter reads JSON, not the README.** `.github/scripts/listings.json` on the `dev` branch (schema documented in `.claude/agents/ingestion-agent.md`). The FAANG+ 🔥 flag exists only in the README, so a light second pass extracts just the 🔥 company set. README table parsing is the fallback only.
- **Ingestion has a third stage: posting-detail fetch.** After dedup and a provisional stage-1 score, listings clearing a configurable threshold get their posting page fetched for description text and application deadline — dedicated parsers for Greenhouse/Lever/Ashby/Workday, generic text extraction otherwise; rate-limited, robots-aware, URL-deduped within a run. `detailFetchedAt`/`detailFetchStatus`/`atsKind` on Listing make silent parser failures visible. Re-fetch only when the source record changes or the fetch exceeds a configurable age.
- **Dedup**: exact match on `dedupKey` (normalized company|title|location bucket — indexed, NOT unique), then fuzzy title match within company+location. Hard guard that overrides any fuzzy match: records whose `requisitionId` or canonical URL differ are NEVER merged — a wrong merge silently hides a real role, so bias toward not merging when uncertain. Every merge is recorded in `Listing.mergedFrom`; the UI offers a split action. Listings gone from all sources become `likelyClosed` — rows are never deleted.
- **User flags on Listing**: `saved` (watching; drives closing-soon alerts) and `dismissed` (cleared from the main table and stays cleared across refreshes).
- **Raw fetches persist** gzipped on `IngestRun` rows before parsing (diffable, debuggable), pruned after `RAW_RETENTION_DAYS`.
- **Scoring is two-stage**: stage 1 pure/deterministic from `config/scoring.json` (read and hashed on every scoring run — editing weights needs no restart; the file is volume-mounted into both containers at `config/scoring.json`); stage 2 optional Claude pass for high scorers, clamped ±15, cached in `LlmAssessment` by posting-text hash, and **skipped entirely when `postingText` is null** — never pay for a call that only sees a title. Disqualifiers zero the score but keep the breakdown; hiding them is a UI concern.
- **Worker vs app**: worker (node-cron) owns scheduled ingestion, rescoring, alerts, backups. "Refresh now" = app calls the worker's HTTP endpoint on the internal compose network (never exposed via Traefik).
- **"Not Applied" is the absence of an Application row**; a row is created on first user interaction. `Application.listingId` is optional: manual entries (own `companyName`/`roleTitle`/`location`) are first-class for roles found outside the sources — bulk imports mostly won't match a listing — and can later be linked to one while keeping their fields. Status history lives in `StatusEvent`.
- **Auth**: Auth.js (next-auth v5) generic OIDC provider → Authentik; access restricted to the single allowed subject/email from env.
- **All external data is untrusted**: source payloads, CSV imports, PDF text, and LLM responses all pass Zod validation at the boundary; scraped text is sanitized before rendering.

## Subagents

`.claude/agents/` defines specialists — ingestion-agent, scoring-agent, frontend-agent, devops-agent, reviewer-agent. Use them for work in their domains; run independent work in parallel. reviewer-agent reviews each phase's diff before it is presented to the user.

## Build phases (stop for user review after each)

1. Schema + ingestion (adapters, dedup, worker, fixtures + tests)
2. Scoring engine + tests
3. UI + application tracker
4. Alerts + resume matching
5. Deployment (Docker, compose, Traefik, backups)

Secrets/config: every env var documented in `.env.example`; real values only in gitignored `.env*`.
