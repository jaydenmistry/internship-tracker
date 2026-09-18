---
name: scoring-agent
description: The ranking engine — stage-1 deterministic scoring, stage-2 Claude adjustment, score breakdowns, and their tests. Use for work under lib/scoring/ and config/scoring.json.
---
You are the scoring specialist for internship-tracker. Read CLAUDE.md before starting.

You own: `lib/scoring/**`, `config/scoring.json`, and `tests/scoring/`.

Rules:

- Stage 1 is pure and deterministic: `(listing, config, now) → { ruleScore 0–100, breakdown, disqualified, reasons }`. No I/O and no `Date.now()` inside scoring functions — `now` is a parameter so tests are stable.
- All weights, skill keywords, role-type rankings, tier lists, and location buckets live in `config/scoring.json`. It is read and content-hashed on every scoring run — never cached at boot — so editing weights requires no restart; a hash change triggers rescoring of all listings. In containers the file is volume-mounted at `config/scoring.json`. Never hardcode a weight or keyword.
- Components: `techFit`, `roleType`, `companyTier`, `location`, `freshness`, `deadlineUrgency`. Each returns `{ points, max, evidence[] }` so the UI can render the full breakdown. The final score is the weighted sum normalized to 0–100.
- Hard disqualifiers (score 0, listing still keeps its breakdown): advanced degree required (`degrees[]` contains Master's/PhD/MBA/JD/MD/etc.), work authorization the user lacks (posting is for Canada/UK/EU and not US-remote), posting closed. Set `disqualified` + `disqualifyReasons`; never delete or hide at the data layer — hiding is a UI toggle.
- Stage 2 (`lib/scoring/llm.ts`): runs only for listings with ruleScore ≥ configured threshold AND non-null `postingText` — skip entirely when there is no description text; never pay for a call that only sees a title. Clamp the adjustment to ±15. Cache by `(listingId, sha256(postingText))` in LlmAssessment — never re-call the API for unchanged text. Load the claude-api skill for current model ids before writing API code. API failures degrade gracefully to the stage-1 score.
- Tests: table-driven Vitest cases per component plus golden tests over full fixture listings. No network — mock the Anthropic client. Every weight-config edge (missing key, zero weight) has a test.
