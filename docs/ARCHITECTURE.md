# Architecture

How the internship tracker actually works, written from the code as it exists
(through Phase 3). Where the original plan in `CLAUDE.md` describes something
that isn't built yet, or was built differently, this document says so — see
[Plan vs. reality](#plan-vs-reality) first if you're orienting.

---

## Data flow

One **cycle** (`lib/cycle.ts`, `runFullCycle`) runs the whole pipeline. It is
triggered by the worker's cron schedule (`INGEST_CRON`, default 06:00 daily) or
by `POST /refresh` on the worker's internal HTTP port — though nothing in the UI
calls that endpoint yet (see [Plan vs. reality](#plan-vs-reality)).

```mermaid
flowchart LR
  subgraph ext["External sources"]
    S1["Simplify<br/>.github/scripts/listings.json<br/>+ README 🔥 set"]
    S2["intern-list.com<br/>→ jobright.ai minisite<br/>(newest 50 per run)"]
    ATS["Posting pages<br/>Greenhouse · Lever · Ashby<br/>Workday · generic"]
  end

  subgraph worker["worker process — worker/index.ts (node-cron)<br/>planned: worker container"]
    direction TB
    I["1 · Ingest<br/>adapters → Zod-validated<br/>NormalizedListing"]
    D["2 · Dedup + upsert<br/>per-source ListingSource<br/>merge guard → Listing"]
    C["2b · Likely-closed pass<br/>only if every adapter healthy"]
    P["3 · Provisional stage-1 score<br/>ruleScore + gateScore<br/>(no ranks)"]
    F["4 · Posting-detail fetch<br/>gateScore ≥ detailFetchMin<br/>new text ⇒ hash := null"]
    R["5 · Final stage-1 rescore<br/>+ recompute ranks"]
    L["6 · Stage-2 Claude pass<br/>ruleScore ≥ llmMin, has text<br/>cached by text hash"]
    I --> D --> C --> P --> F --> R --> L
  end

  DB[("Postgres<br/>local: prisma dev<br/>planned: postgres container")]

  subgraph app["Next.js app — app/<br/>planned: app container"]
    UI["Listings table · detail panel<br/>Tracker · Import · CSV export"]
  end

  S1 --> I
  S2 --> I
  ATS --> F
  D --> DB
  C --> DB
  P --> DB
  F --> DB
  R --> DB
  L --> DB
  DB <--> UI
```

**Containers do not exist yet.** Deployment (Dockerfile, compose, Traefik) is
Phase 5. Today everything runs as local processes: `npm run dev` (app),
`npm run worker` (worker), and `npx prisma dev` (Postgres). The subgraph labels
show where each stage runs now and which container it is planned to move into.

### Why the stages are ordered this way

Most sources ship no description text, and tech fit — the heaviest scoring
component — needs text. Fetching every posting page would be thousands of
requests, so a cheap **provisional** score picks which pages are worth
fetching, then the **final** pass rescores exactly the listings that gained
text. The provisional pass gates on **`gateScore`**, which is the same weighted
score with tech fit *excluded from the denominator*. Gating on the displayed
score deadlocked the pipeline: no text → tech fit 0 → below the gate → never
fetched → no text. At one point only 22 of ~2,860 listings had ever been fetched.

---

## Data model

```mermaid
erDiagram
  Company ||--o{ Listing : "posts"
  Listing ||--o{ ListingSource : "seen in"
  Listing ||--o{ LlmAssessment : "assessed by"
  Listing |o--o| Application : "tracked as"
  Application ||--o{ StatusEvent : "timeline"
  Listing |o..o{ AlertLog : "listingId (no FK)"

  Company {
    string normalizedName UK
    boolean faangPlus
    int tierOverride
  }
  Listing {
    string dedupKey "indexed, NOT unique"
    boolean likelyClosed
    boolean saved
    boolean dismissed
    int ruleScore
    int gateScore
    int finalScore
    json scoreBreakdown
    boolean disqualified
    string scoringConfigHash
    int rank
    int previousRank
    int previousScore
    boolean scoreMoved
    json mergedFrom
    string detailFetchStatus
  }
  ListingSource {
    string source "plain string, not enum"
    string sourceUid
    boolean active
    json raw
  }
  LlmAssessment {
    string textHash
    int adjustment
    string rationale
  }
  Application {
    string listingId "optional, unique"
    enum status
    string notes
    string companyName
    string roleTitle
  }
  StatusEvent {
    enum fromStatus
    enum toStatus
    datetime occurredAt
  }
  IngestRun {
    string source
    boolean ok
    bytes rawGz
    string rawSha256
  }
  Resume {
    string text
    boolean active
  }
  Setting {
    string key PK
    json value
  }
  AlertLog {
    string dedupeKey UK
    enum kind
    enum channel
  }
```

`IngestRun`, `Resume` and `Setting` have no relations. `AlertLog.listingId` is a
plain string with no foreign key.

### Models and their invariants

**Company** — one row per normalized company name.
- `normalizedName` is unique; listings attach by it.
- `faangPlus` is only ever *raised* by source data (the Simplify README 🔥 set),
  never lowered, so a company dropping out of the README doesn't lose its tier.
- `tierOverride` beats `faangPlus` in scoring. There is no UI to set it yet.

**Listing** — one canonical row per deduped job posting.
- **Never deleted.** A listing absent from every source is flagged
  `likelyClosed`. That flag is only set when *every* adapter reported success
  and there were zero per-item ingest failures, so a source outage or an ingest
  bug can't mass-close the catalog.
- `dedupKey` (`normalized company | normalized title | location bucket`) is
  **indexed but not unique** — distinct requisitions legitimately share it.
- **Merge guard:** two records whose requisition id, or same-host canonical URL,
  differ are never merged, whatever the fuzzy title score says. Multiple
  surviving candidates means *create*, not guess. Every merge is recorded in
  `mergedFrom`. There is no UI to split a bad merge yet (see Plan vs. reality).
- The scoring snapshot (`ruleScore`, `gateScore`, `finalScore`,
  `scoreBreakdown`, `disqualified`, `disqualifyReasons`) is rewritten by every
  stage-1 pass. A disqualified listing keeps its full breakdown but scores 0.
- `rank` is assigned at the end of each final scoring pass; null when
  disqualified. `previousRank` / `rankChangedAt` change **only** when rank
  actually changes, so "moved yesterday" stays true through later no-op runs.
- `scoreMoved` records whether the listing's **own** `finalScore` changed in the
  run that last moved its rank; it is written in the same statement as
  `previousRank`, so it stays paired with the move it describes.
  `previousScore` is the baseline that comparison uses, rolled forward for
  every listing at the end of each ranking run (so it is always exactly one run
  behind, and the roll-forward must happen *after* the two statements that read
  it). The table's ↑/↓ is gated on `scoreMoved`: a rank is a position in a field
  of ~1,600, so a listing that did not change at all still gets shoved around by
  everything that did — 1,425 of 1,615 ranked listings carried a rank change
  while sitting still, and an arrow on 88% of rows reports nothing.
- `mergedFrom` holds two entry shapes discriminated by `kind`: merge entries
  pushed by the pipeline, and reverse `splitFrom` entries written onto a listing
  that was split back out. Read it only through
  `lib/ingestion/merge-audit.ts` — it is `Json[]`, so Postgres returns whatever
  was written, including older shapes.
- `saved` / `dismissed` are user flags. Dismissal survives refreshes.

**ListingSource** — one row per (source, source-native id).
- `(source, sourceUid)` is unique — this, not `dedupKey`, is row identity.
- `source` is a plain string so adding an adapter needs no migration.
- `raw` holds the latest raw record from that source.

**IngestRun** — one row per adapter per cycle.
- The raw payload is persisted **before parsing** (adapters call
  `ctx.saveRaw`), so a parser crash still leaves the payload to debug.
- An identical consecutive payload stores only `rawSha256` (`rawGz` null).
- Payloads older than `RAW_RETENTION_DAYS` have `rawGz` nulled; the row stays.

**LlmAssessment** — the stage-2 cache.
- `(listingId, textHash)` is unique. Only the assessment matching the listing's
  **current** `postingTextHash` applies; older ones are ignored, never re-billed.
- The adjustment is clamped to `±llm.maxAdjustment` (15) regardless of what the
  model returns. None exist yet — `ANTHROPIC_API_KEY` has never been set.

**Application** — the user's tracking record.
- `listingId` is optional and unique: a listing has at most one application,
  and **manual** applications (roles found outside the sources) have none.
- `companyName` / `roleTitle` / `location` are kept even when linked, so an
  unlink or a bad upstream merge never loses what the user typed.
- `appliedAt` records the **first** submission. Moving back to `APPLIED` (an
  accidental OA corrected, or un-apply then re-apply) never overwrites it.
- **"Not applied" has two representations** — this differs from the original
  plan, which said "absence of a row". It is *either* no row, *or* a row with
  status `NOT_APPLIED` that exists only to hold notes written before applying.
  Un-applying a listing whose application has notes keeps the row rather than
  deleting the notes. Readers must treat both the same: the table folds null
  into `NOT_APPLIED`; the tracker and dashboard exclude `NOT_APPLIED` rows.

**StatusEvent** — append-only status timeline.
- `recordStatus` writes nothing for a no-op transition, so every event is a
  real change.
- Events are deleted only together with their application (un-applying a
  listing that has no notes).

**Resume** — extracted resume text for keyword matching.
- Written by `lib/resume/store.ts` on upload at `/resume`. Text is extracted
  **once, at upload** (`lib/resume/extract.ts`, via `unpdf`); the PDF bytes are
  never stored, and nothing in the app needs a file on disk.
- Latest `active` row wins: an upload deactivates every earlier row in one
  transaction and keeps it, so a replacement is never destructive. Extraction
  happens *before* that transaction — a PDF that yields nothing usable must
  leave the previous resume active rather than replacing it with an empty one.
- Read through `getActiveResume()` only. The detail panel matched the same row
  by copying the query once; one definition avoids the panel matching against a
  different resume than the upload page reports.
- Matching is for **tailoring, not scoring** — it never touches a score.

**Setting** — key/value JSON for UI-editable config. Holds the alert thresholds
edited at `/alerts`, Zod-validated on read with defaults when absent or
malformed. Scoring weights live in `config/scoring.json` and never here.

**AlertLog** — alert de-duplication (`dedupeKey` unique, and `channel` is part
of the key, so the same alert to Discord and email is two rows). **Written only
after a successful send**: recording first would dedupe a failed alert away
permanently.

---

## How rescoring is triggered

The part most likely to be forgotten. Stage 1 (`runStageOne` in
`lib/scoring/rescore.ts`) rescores a listing when **any** of these hold:

| Condition | What causes it |
|---|---|
| `scoringConfigHash` is null | A listing marked its own score stale (below) |
| `scoringConfigHash` ≠ current hash | `config/scoring.json` changed, **or** the engine version was bumped |
| `scoredAt` is null | Never scored |
| `scoredAt` older than `RESCORE_MAX_AGE_HOURS` (default 20) | Time passed |

**The current hash is `v{SCORING_ENGINE_VERSION}-{sha256(config)}`.**
- The config part is recomputed on *every* scoring run — the file is re-read
  each time, never cached — so editing weights needs no restart and triggers a
  full rescore on the next run. Key order and whitespace don't count; content does.
- `SCORING_ENGINE_VERSION` (currently **3**, in `lib/scoring/engine.ts`) must be
  **bumped by hand whenever scoring logic changes**. Without it, a code deploy
  that changes scores would rescore nothing — the config hash can't see code.
  Forgetting is survivable: the max-age reclaim rescores everything within a day.

**Self-invalidation — `scoringConfigHash := null`.** A listing marks its own
score stale, with no extra bookkeeping, when:
- the detail fetch yields richer posting text,
- the detail fetch finds a **changed** deadline (an unchanged one doesn't count),
- an adapter supplies richer posting text on ingest,
- a `likelyClosed` listing reappears in a source (reopened),
- an adapter supplies a changed deadline,
- a **merge** adopts richer posting text or reopens the target — the same rule
  the plain update path follows. Without it, the merge that first gives a
  listing a real description leaves it scored on its title, and stage 2 is
  gated on having text, so the merge that earns an LLM pass would not trigger one,
- a **split** pulls a merged-in record back out: both the parent and the new
  listing are flagged. If the parent was holding posting text the departing
  record had donated, that text, its hash, and the detail-fetch stamps are
  cleared too, so stage 3 fetches the parent's own posting page instead of
  scoring it against a role that has left,
- the likely-closed pass flags it (this is what makes the "posting closed"
  disqualifier fire for listings that close *after* first being scored).

**Max-age reclaim.** `freshness` decays with time and `deadlineUrgency` opens
and closes, so a purely hash-gated pass would freeze both at first-score time.
Any row not scored within `RESCORE_MAX_AGE_HOURS` is reclaimed. Under the daily
cron that is one full pass per day. Scoring itself is fast; the cost is the
per-row writes — a full pass over ~2,900 listings measured **~90 seconds**
against the local `prisma dev` database. Writes go in 50-row transactions, and
a chunk that fails is retried row by row, so a slow moment or a bad row never
aborts the pass (an earlier 200-row transaction ran past Prisma's 5-second
limit and threw out of the whole rescore). A row that still fails keeps its
stale hash and is picked up next pass.

**Rank churn is expected.** Because rank is positional, one listing's score
moving by a single point shifts every listing it passes by one place — a daily
pass moves some ranks even when those listings didn't change themselves (two
forced passes minutes apart moved 8 and 31).

**Stage 2** runs after stage 1 on listings that are not disqualified, dismissed
or closed, have `ruleScore ≥ thresholds.llmMin`, and **have posting text**
(never a title-only call). Stage 1 resets `llmAdjustment` on every rescore;
stage 2 then re-applies it from the `(listingId, textHash)` cache at no API
cost. Calls are capped by `LLM_MAX_CALLS_PER_RUN`.

**Ranks** are recomputed at the end of every `rescoreListings` call, except the
cycle's provisional pass (`updateRanks: false`) — ranking half-scored listings
would report movement that the final pass immediately undoes.

`rescoreListings({ force: true })` rescores everything regardless; nothing in
the cycle calls it.

---

## The `prisma dev` schema trap

The local database is `npx prisma dev`, which fronts Postgres with a proxy. That
proxy has bitten this project in three distinct ways. All three fail
**silently**: queries succeed, against the wrong data.

**Form 1 — the database name is ignored.** Every database name in a connection
string routes to the same physical database. An early attempt at isolating
tests with a separate `…_test` database appeared to work while the integration
tests were wiping the real ingested listings on every run.
*Fix:* tests are isolated by Postgres **schema** (`itest`), not by database.

**Form 2 — the driver adapter ignores `?schema=`.** With Prisma 7's driver
adapters, the connection string goes to node-postgres, which drops parameters
it doesn't recognize. Adding `?schema=itest` changed nothing; tests still hit
`public`.
*Fix:* `lib/db.ts` reads `?schema=` itself and passes it to `PrismaPg`
explicitly.

**Form 3 — `search_path` leaks between connections.** A connection that doesn't
name its schema inherits whatever `search_path` the proxy last had — often
`itest`, left over from a test run. Two symptoms:
- *`prisma db push` / migrations:* a push without an explicit schema went to
  `itest`. The result is a paradox — the app says a new column doesn't exist
  while `db push` insists it already does.
- *Raw SQL:* `PrismaPg`'s schema option applies only to queries Prisma
  generates. `$executeRaw` is sent verbatim, so an unqualified `"Listing"`
  resolved through the leaked `search_path`. The first rank pass reported
  success while writing 2 rows in the test schema instead of 1,615 in the
  real one.

*Fixes:* `DATABASE_URL` always names its schema (`?schema=public`); push by
hand only with `--url` including the schema; and raw SQL never uses an
unqualified table name — it goes through `qualifiedListingTable()` in
`lib/scoring/rescore.ts`, which validates the schema as a safe identifier.

**Related, not the proxy:** after a schema migration, a running `next dev`
keeps its old generated Prisma client and fails with `Unknown field` until the
dev server is restarted. And `prisma dev` itself does not survive the shell or
session that started it — if the app shows `ECONNREFUSED`, run
`npx prisma dev start default` (the data persists).

---

## Where the knobs live

**`config/scoring.json` — no restart.** Re-read and hashed on every scoring
run. Any content change rescores the whole catalog on the next run.
- `weights` — relative weight per component.
- `techFit.skills` — your skills, their points and match patterns. Also the
  first part of the resume-matching vocabulary.
- `roleType.classes` — ranked role classes; **first match wins, array order is
  specificity, not value**. Reorder to retune.
- `companyTier`, `location`, `freshness` (half-life), `deadlineUrgency` (window).
- `disqualifiers` — advanced degrees (with the bachelor's exemption),
  blocked countries, closed.
- `thresholds.detailFetchMin` — **measured on `gateScore`**, not the displayed
  score. Currently 50. Raise it if fetch volume becomes a problem.
- `thresholds.llmMin` — measured on `ruleScore`. Currently 70.
- `llm.*` — enabled, model, max adjustment, text/rationale/token caps, and
  `temperature` (**0**; an assessment is cached forever against the posting-text
  hash, so the first roll is the score the listing keeps — at the API default,
  four identical calls on one posting spread 10 points on a ±15 scale).

**`SCORING_ENGINE_VERSION` in `lib/scoring/engine.ts` — code, needs a deploy.**
Bump it when scoring logic changes (see above).

**`Setting` table — no restart by design.** Holds the alert thresholds edited at
`/alerts`: digest and high-score minimums, the closing-soon window, per-channel
enable flags, and the per-run send cap. Read through `lib/alerts/config.ts`,
which Zod-validates and falls back to defaults.

**Environment variables — restart the process that reads them.** `.env` is
loaded once at process start, so every change needs a restart even for values
that are read on every call. `.env.example` documents them all.

| Variable | Read by | Purpose |
|---|---|---|
| `DATABASE_URL` | app, worker, Prisma CLI | Must include `?schema=` |
| `SHADOW_DATABASE_URL` | Prisma CLI only | `migrate dev/diff` locally |
| `INGEST_CRON` | worker | Cycle schedule |
| `WORKER_PORT` | worker | Internal `/refresh` + `/healthz` |
| `USER_AGENT_CONTACT` | worker | Contact in the scraper User-Agent |
| `RAW_RETENTION_DAYS` | worker | Raw payload retention |
| `DETAIL_REFETCH_DAYS` | worker | Re-fetch posting pages after N days |
| `DETAIL_MAX_PER_RUN` | worker | Posting fetches per cycle (default 250) |
| `SCORING_CONFIG_PATH` | worker, app | Location of `scoring.json` |
| `ANTHROPIC_API_KEY` | worker | Stage 2; unset = cache only |
| `LLM_MAX_CALLS_PER_RUN` | worker | Claude spend cap (malformed ⇒ default, never "no cap") |
| `LLM_MAX_CANDIDATES_PER_RUN` | worker | Bounds the stage-2 candidate query |
| `RESCORE_MAX_AGE_HOURS` | worker | Max-age reclaim window |
| `DIGEST_CRON` | worker | Daily-digest schedule |
| `CLOSING_SOON_CRON` | worker | Closing-soon schedule |
| `ALERT_TIMEZONE` | worker, app | Timezone for alert dates; also used to format AlertLog timestamps server-side, so the recent-alerts list can't hydrate-mismatch |
| `DISCORD_WEBHOOK_URL` | worker, app | Discord channel; unset = channel disabled |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | worker, app | SMTP endpoint (`SMTP_SECURE` defaults from the port: implicit TLS on 465) |
| `SMTP_USER` / `SMTP_PASS` | worker, app | Optional; must be set together or not at all |
| `SMTP_FROM` / `SMTP_TO` | worker, app | Envelope addresses; unset = channel disabled |

Alert env vars are read by the **app** as well as the worker, because every
alert kind is manually triggerable from `/alerts` through the same code path the
cron uses.

The app reads `SCORING_CONFIG_PATH` too, because the detail panel shows weights
and builds the resume vocabulary from the config.

---

## Directory map

```
app/                       Next.js App Router (UI only; no auth yet)
  page.tsx                 / — the listings table
  listings/                table, detail panel, context menu, their actions
  tracker/                 /tracker — kanban/list + minimal dashboard
  import/                  /import — paste/CSV import with match review
  resume/                  /resume — PDF upload; text extracted once, at upload
  alerts/                  /alerts — thresholds, per-kind "Send now", recent sends
  api/applications/export/ GET → applications CSV (round-trips via /import)
  layout.tsx, globals.css  shell, nav, dark theme tokens (Tailwind v4, CSS config)
components/                small shared UI primitives
lib/
  db.ts                    Prisma client; passes ?schema= to the adapter
  cycle.ts                 one full refresh, stages in order
  ingestion/
    adapters/              simplify, intern-list, registry, NormalizedListing contract
    detail/                posting-page fetchers + robots/rate-limit/SSRF guard
    normalize.ts           company/title/location normalization, dedupKey, req ids
    dedupe.ts              merge decision + hard guard
    pipeline.ts            ingest, upsert, likely-closed, detail stage, pruning
    merge-audit.ts         reads Listing.mergedFrom (Zod); imported by the read
                           models so they don't pull the pipeline into their graph
    split.ts               undo one merge: re-normalize ListingSource.raw and
                           rebuild the listing the pipeline would have created
  scoring/
    config.ts              loads + validates + hashes scoring.json
    engine.ts              pure stage-1 scorer + disqualifiers; SCORING_ENGINE_VERSION
    llm.ts                 stage-2 Claude call (structured output, clamped)
    rescore.ts             persistence: stage 1, stage 2, ranks, raw-SQL schema guard
  listings/                table read model, detail read model, row mutations
  applications/            import parse/match, commit, tracker + dashboard, CSV
  resume/                  extract (unpdf), store, vocabulary + posting↔resume match
  alerts/
    settings.ts            threshold schema + defaults (pure)
    config.ts              Setting-table read/write; re-exports settings.ts
    build.ts               pure payload builders + dedupe keys
    data.ts                candidate queries + recent-alert list
    send.ts                build → drop already-sent → send → record AlertLog
    channels/              discord webhook, smtp email (injectable transports)
worker/index.ts            node-cron (cycle, digest, closing-soon) + /refresh, /healthz
prisma/                    schema.prisma + migrations
config/scoring.json        every scoring weight, pattern and threshold
tests/                     Vitest; mirrors lib/; fixtures/ are real captured payloads
  global-setup.ts          creates + syncs the itest schema
  setup-env.ts             points tests at the itest schema
docs/                      this document
.claude/agents/            subagent definitions used to build the project
```

---

## Plan vs. reality

What `CLAUDE.md`'s original plan describes, against what exists after Phase 3:

| Planned | Actual |
|---|---|
| Docker containers: app, worker, postgres | **Not built** (Phase 5). Local processes. |
| OIDC auth via `proxy.ts` | **Not built** (Phase 5). Nothing is authenticated: anyone who can reach the port can read the catalog, replace the stored resume, trigger real Discord/SMTP sends from `/alerts`, split listings, and download `/api/applications/export`. Phase 5 must cover `/api/*` and the Server Actions, not only pages. |
| `scripts/backup.sh` | **Not built** (Phase 5). |
| `lib/alerts/`, Discord + SMTP | Built. **Never delivered a real message** — both transports are injected in tests, so the Discord webhook contract and a real SMTP handshake are unexercised; the first live "Send now" is the real test. |
| Resume PDF upload | Built. Upload, extraction and the matched panel state were driven end to end through the real Server Action over real multipart. |
| "Refresh now" button → worker `/refresh` | Endpoint exists; **no UI calls it**. |
| UI action to split an incorrect merge | Built (`lib/ingestion/split.ts` + the shared row-action registry). Exercised against a real merged listing copied into the test schema; **never run against the live catalog**. The two concurrency guards (a racing ingest, two simultaneous splits) are reasoned about and coded, not covered by a test — that needs two interleaved transactions. |
| "Not applied" = absence of an Application row | Also a `NOT_APPLIED` row holding pre-apply notes. |
| Detail fetch gated on the score | Gated on **`gateScore`** (tech fit excluded) — the plain score deadlocked. |
| Rank derived for display | **Persisted** on Listing, with movement history. The ↑/↓ indicator is shown only when the listing's own score moved (`scoreMoved`) — 88% of ranked rows carried a cascade move, which told the reader nothing. |
| Stage 2 adjusts scores | It never ran: the structured-output schema sent `minimum`/`maximum` on an integer, which the Messages API rejects with a 400, so **every** stage-2 call failed while the mocked tests stayed green. Fixed, and now pinned at `temperature: 0`. |
| intern-list HTML scrape | Parses the embedded jobright.ai minisite's `__NEXT_DATA__`; gets only the newest 50 per run because deeper pages need jobright's robots-disallowed `/api`. |
| Separate test database | Separate test **schema** (see the `prisma dev` trap). |
| Prisma (unspecified version) | Prisma 7 with the `@prisma/adapter-pg` driver adapter. |
