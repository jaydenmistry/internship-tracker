# Networking feature — plan

**Status: proposed, nothing built.** This is a plan for review. Once work
starts, what gets built moves into `docs/ARCHITECTURE.md` and `CLAUDE.md`, and
this file either gets deleted or turns into a record of the decisions made.

Open items are marked **[DECIDE]**. Anything else that's wrong, strike it out or
rewrite it inline.

### Changes from the original plan

- **Drafting runs on your Claude subscription.** It uses the Claude Agent SDK
  with Sonnet 5 and needs no API key.
- **Scoring stays on API credits, unchanged.** The scoring key moves to its
  own environment variable so the drafting client can never pick it up by
  accident. See "Claude access for drafting."
- **Review fixes folded in:**
  - time-based status changes (a `now` input and a daily recompute)
  - manual status and snooze fields in the schema
  - rules for LinkedIn connection notes and in-person meetings
  - `followUpsSent` defined precisely
  - voice-edit detection normalized
  - digest deduplication for follow-ups
  - Draft disabled for `doNotContact` contacts
- **The seven original open questions are resolved.** See "Decisions made" at
  the end.

---

## Goal

Help with cold outreach and networking for Summer 2027 SWE internships:

- keep track of the people you know at each company
- log every message you send or receive
- remind you when a follow-up is due
- have Claude draft messages in your voice

The feature lives inside the tracker. Contacts connect to the companies,
listings and applications the app already has.

### In scope

- **Contact CRM.** People linked to a `Company` and optionally to a listing or
  application.
- **Outreach log.** Every message in or out, on any channel.
- **Follow-up reminders.** A fixed cadence you can edit, shown on a `/network`
  dashboard and in the daily digest.
- **AI drafting** through your Claude subscription. Four kinds of message:
  - cold email
  - LinkedIn connection note
  - follow-up/nudge
  - thank-you/referral ask

  Drafts learn your voice from a short hand-written voice note plus how you
  edited earlier drafts.

### Out of scope (deliberately)

- **The app sending mail itself.** You send every message through mailto or
  copy/paste. The app holds no mail credentials and has no deliverability
  problems to deal with. This matches the project-wide rule against storing
  credentials for third-party sites.
- **Gmail/Outlook OAuth, or detecting replies automatically.** You log replies
  by hand.
- **Finding contacts for you.** That includes guessing email patterns,
  Hunter/Apollo-style lookup APIs, and scraping LinkedIn (which breaks their
  terms of service). You enter every contact by hand.
- **Networking affecting the listing score.** Contacts show up next to
  listings; they don't change the ranking. A small referral bonus in
  `config/scoring.json` could come later, but it isn't planned.
- **Changes to scoring.** Scoring keeps its API-key client, temperature 0 and
  cache. The only change is the name of its key variable.
- **Anyone but you using drafting.** Subscription auth only covers your own
  individual use. If the app is ever opened to other people, drafting must
  move to an API key first.

---

## Claude access for drafting

The app ends up with two separate paths to Claude:

| | Scoring | Drafting |
|---|---|---|
| Client | Anthropic SDK (existing `LlmClient`) | Claude Agent SDK (new) |
| Auth | API key | Claude subscription token |
| Billing | API credits | Your plan's usage limits |
| Environment variable | `SCORING_ANTHROPIC_API_KEY` (renamed) | `CLAUDE_CODE_OAUTH_TOKEN` |

### Why the Agent SDK instead of `claude -p`

Both run the same Claude Code engine, with the same auth and the same usage
limits. The SDK wins on day-to-day handling:

- It returns typed messages and result objects, so recognizing a usage limit,
  an auth failure or a timeout doesn't depend on parsing CLI output.
- It has abort and timeout handling built in.
- The call lives in-process, next to the existing `LlmClient` pattern, which
  keeps the fake client for tests simple.

`claude -p` would also work: spawned with an args array and the prompt on
stdin, there's no shell-escaping risk. The SDK's main costs are an extra
dependency and option names that can change between versions, so pin its
version.

### Keeping the two keys apart

This is the one real risk of running both paths. Claude Code prefers an API
key over the subscription when both are present, so if the scoring key leaked
into drafting's environment, drafting would silently bill API credits.

Three layers prevent that:

1. **The scoring key is renamed** to `SCORING_ANTHROPIC_API_KEY` (host
   `.env`: `TRACKER_SCORING_ANTHROPIC_API_KEY`) and passed explicitly to the
   Anthropic SDK constructor. The rename applies to **both** services in
   `deploy/compose.tracker.yml`: the app container runs stage-2 scoring too,
   because listing row actions call `rescoreAll` through
   `app/listings/actions.ts`. The Anthropic SDK reads
   `ANTHROPIC_API_KEY` by default, so the explicit pass is required.
2. **Boot check (both containers):** the app and the worker refuse to start if `ANTHROPIC_API_KEY` or
   `ANTHROPIC_AUTH_TOKEN` is set anywhere in its environment.
3. **Allowlisted environment:** the drafting client passes an explicit
   environment to the SDK instead of inheriting the process's. It contains
   only what Claude Code needs:
   - `PATH`
   - a config directory (see below)
   - `CLAUDE_CODE_OAUTH_TOKEN`

### Auth

- **Getting the token.** Run `claude setup-token` once, on a machine with a
  browser. It produces a long-lived subscription token.
- **Storing the token.** It goes into the host stack's `.env` as
  `TRACKER_CLAUDE_CODE_OAUTH_TOKEN`, passed to the app container as an env var
  like every other secret in the stack (`SMTP_PASS` and the rest). It is
  never stored in Postgres or the repo. It's a credential for your own
  Anthropic account, like the scoring key, not a third-party site credential.
- **Expiry.** Token rotation is documented in `ARCHITECTURE.md`. An expired
  token shows up as "Claude not connected" (below), not as a crash.

### Drafting client: `lib/claude/draftClient.ts`

It sits behind a swappable interface like `LlmClient`, so tests use a fake,
and drafting could move to an API key later without touching `draft.ts`.

- **Locked-down options.** A pure, unit-tested function, `buildQueryOptions()`,
  builds the SDK options:
  - a custom system prompt that replaces Claude Code's default
  - no tools and no MCP servers
  - a single turn
  - no filesystem settings loaded, so the repo's own `CLAUDE.md` and any
    `.claude/` settings never leak into prompts
  - an empty temp directory as the working directory
  - the allowlisted environment
  - model `claude-sonnet-5`, from the `drafting` config block

  Check the exact option names against the SDK version pinned when this gets
  built.
- **Timeout.** Every call has one, and aborts cleanly when it's hit.
- **Output.** It returns text. `draft.ts` parses it and validates it with Zod.
- **Typed errors.** Failures map to `NotAuthenticated`,
  `UsageLimited { resetsAt? }`, `Timeout` or `BadOutput`.
- **No saved transcripts.** Claude Code saves session transcripts locally by
  default. Turn that off, or point its config directory at a tmpfs, so prompts
  containing contact data don't pile up on disk outside Postgres, its backups
  and its auth gate.

### What to know about the subscription path

- **Temperature can't be set.** The default suits drafting, and Regenerate
  still gives a fresh take.
- **Drafts share your plan's usage limits.** They count against the same
  5-hour and weekly limits as your own Claude use. At a few drafts a day this
  is negligible, but if you've just hit your limit in Claude Code, Draft will
  be unavailable until it resets.
- **The policy may change.** Programmatic subscription use currently draws
  from the normal plan limits. Anthropic announced a separate monthly Agent
  SDK credit, then paused that change on June 15, 2026. Because the client is
  behind an interface, adapting is a client or config change.

### "Claude not connected"

This applies when the token is missing or auth fails:

- The Draft button is disabled, with an explanation.
- A banner on `/network/settings` says what's wrong.

Hand-written messages keep working, and scoring is unaffected either way.

### Privacy

Drafting prompts go through your consumer Claude account. That means your
account's privacy settings and the consumer terms govern the data, not the
API's commercial terms (scoring stays under those). Before drafting ships,
confirm that the model-training setting in your claude.ai privacy settings is
off, because drafting prompts contain third-party contact data. The one-line
UI note on drafting says the same.

---

## Data model

There is one migration. All of it is additive; the only change to an existing
table is one new optional foreign key on `Application`.

```prisma
enum ContactKind {
  RECRUITER
  ENGINEER
  HIRING_MANAGER
  ALUMNI
  OTHER
}

enum ContactStatus {
  NOT_CONTACTED
  PENDING_CONNECTION // LinkedIn connection note sent, not yet accepted
  AWAITING_REPLY
  REPLIED
  CHATTED            // had a call / coffee chat (manual)
  REFERRED           // they referred you somewhere (manual)
  COLD               // cadence exhausted, no reply
}

enum OutreachDirection { OUT IN }

enum OutreachChannel { EMAIL LINKEDIN IN_PERSON OTHER }

enum OutreachType {
  COLD
  CONNECT_NOTE
  ACCEPTED       // inbound: they accepted a LinkedIn connection request
  MEETING        // outbound: met in person (career fair, coffee chat)
  FOLLOW_UP
  THANK_YOU
  REFERRAL_ASK
  REPLY          // an inbound message, or a free-form outbound reply
}

model Contact {
  id                 String          @id @default(cuid())
  name               String
  companyId          String?
  company            Company?        @relation(fields: [companyId], references: [id], onDelete: SetNull)
  title              String?
  kind               ContactKind     @default(OTHER)
  email              String?
  linkedinUrl        String?
  howMet             String?         // "UGA career fair 9/2026", "alumni directory"
  notes              String?
  doNotContact       Boolean         @default(false)

  // User-set inputs to computeFollowUpState().
  manualStatus       ContactStatus?  // only CHATTED or REFERRED
  manualStatusAt     DateTime?
  followUpOverrideAt DateTime?       // snooze; cleared when a message is logged

  // Derived by computeFollowUpState() — never written anywhere else.
  status             ContactStatus   @default(NOT_CONTACTED)
  nextFollowUpAt     DateTime?
  followUpsSent      Int             @default(0)

  messages           OutreachMessage[]
  referrals          Application[]   @relation("ReferredBy")
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt

  @@index([companyId])
  @@index([nextFollowUpAt])
  @@index([status])
}

model OutreachMessage {
  id            String            @id @default(cuid())
  contactId     String
  contact       Contact           @relation(fields: [contactId], references: [id], onDelete: Cascade)
  direction     OutreachDirection
  channel       OutreachChannel
  type          OutreachType
  subject       String?
  body          String            // what was actually sent/received; may be empty for ACCEPTED/MEETING
  draftBody     String?           // Claude's original draft; null if hand-written
  sentAt        DateTime
  listingId     String?
  listing       Listing?          @relation(fields: [listingId], references: [id], onDelete: SetNull)
  applicationId String?
  application   Application?      @relation(fields: [applicationId], references: [id], onDelete: SetNull)
  createdAt     DateTime          @default(now())

  @@index([contactId, sentAt])
}

// on Application:
//   referredByContactId String?
//   referredBy          Contact? @relation("ReferredBy", fields: [referredByContactId], references: [id], onDelete: SetNull)
```

### Invariants

- **Only the follow-up function writes the derived fields.**
  `Contact.status`, `nextFollowUpAt` and `followUpsSent` are set only by
  `computeFollowUpState()`. They're stored rather than worked out on read so
  the digest and the due list are plain indexed queries. The function runs in
  three places:
  - in the same transaction as every mutation that touches a contact's
    messages or its manual fields (log, edit, delete, mark sent, set manual
    status, snooze)
  - in the daily recompute (see the follow-up engine)
  - after a change to the cadence settings
- **Manual inputs are separate from derived status.** `manualStatus`,
  `manualStatusAt` and `followUpOverrideAt` are set by you. The only exception
  is that the log-message mutation clears `followUpOverrideAt` in the same
  transaction. The function reads these fields but never writes them.
- **Contacts are never deleted automatically.** `doNotContact` and `COLD` are
  states, the same way listings are never deleted. Deleting a contact yourself
  is a real delete that cascades to their messages. This is deliberate for
  third-party personal data; `doNotContact` covers "stop, but keep the
  record."
- **A company with no listings still gets a real `Company` row.** Adding a
  contact at a company the app hasn't seen creates the row by `normalizedName`,
  using the same normalizer ingestion uses. When a listing from that company is
  ingested later, it attaches to the same row, so "People at {Company}" just
  appears without extra work. The normalizer won't merge different names for
  the same company (for example "Meta" and "Facebook"), so the Add Contact form
  leads with autocomplete against existing companies.
- **`draftBody` is only for voice learning.** It's never shown as "the message."
  `body` is always the version you sent.

---

## Follow-up engine

`lib/networking/followup.ts` is pure, deterministic and fully unit-tested. It
touches no database and doesn't read the system clock; the caller passes `now`.

```ts
computeFollowUpState(
  messages: OutreachMessage[],   // this contact, any order
  contact: {
    doNotContact: boolean;
    manualStatus: ContactStatus | null;
    manualStatusAt: Date | null;
    followUpOverrideAt: Date | null;
  },
  settings: NetworkingSettings,
  tz: string,
  now: Date,
): { status: ContactStatus; nextFollowUpAt: Date | null; followUpsSent: number }
```

### Definitions

- **Opener:** an outbound COLD or REFERRAL_ASK on EMAIL or LINKEDIN. The
  latest opener defines the current cadence.
- **`followUpsSent`:** the number of outbound FOLLOW_UPs after the latest
  opener. A new opener resets it to 0.
- **Latest event:** the most recent of opener, CONNECT_NOTE, ACCEPTED and
  MEETING. It decides which of rules 3–7 applies.

### Rules, in order of precedence

1. **`doNotContact`:** status is computed as usual, but `nextFollowUpAt` is
   always null.
2. **Manual status:** if `manualStatus` is set and no opener has been sent
   since `manualStatusAt`, the status is `manualStatus` and there's no
   follow-up date. A newer opener, such as a referral ask months after a
   coffee chat, supersedes it and restarts the cadence.
3. **Nothing happened yet:** no outbound message of any kind and no ACCEPTED
   gives `NOT_CONTACTED`, with no follow-up date. (Rules 6 and 7 handle a
   connection note, an accepted connection and a meeting, each of which can
   set a date.)
4. **Opener with a reply:** any inbound REPLY after the latest opener gives
   `REPLIED`, with no date. The cadence stops for good. To nudge a contact who
   has gone quiet after replying, set a snooze date or send a new opener.
5. **Opener without a reply:** `AWAITING_REPLY`.
   - The first follow-up is due `firstFollowUpBusinessDays` after the opener.
   - Each later follow-up is due `secondFollowUpBusinessDays` after the
     previous FOLLOW_UP.
   - Once `followUpsSent >= maxFollowUps`, there's no follow-up date. The
     status stays `AWAITING_REPLY` until `secondFollowUpBusinessDays` after
     the last follow-up has passed as of `now`, and then becomes `COLD`.
6. **LinkedIn connection note:**
   - An outbound CONNECT_NOTE with no later ACCEPTED or REPLY gives
     `PENDING_CONNECTION`, with no date. You can't message them until they
     accept.
   - An inbound REPLY to the note gives `REPLIED`.
   - An inbound ACCEPTED (logged with the "Mark connected" button) returns the
     contact to `NOT_CONTACTED`, since no opener has been sent. It also sets a
     one-off "send opener" due date for the next business day, the same way a
     meeting prompts a thank-you.
   - Logging an opener clears that due date and starts the normal cadence
     under rule 5.
   - Pending requests never get a follow-up date, since there's nothing to
     follow up on until they accept. The contacts table shows how long each
     one has been waiting instead (see UI).
7. **In-person meeting:** logging a MEETING sets the status to `CHATTED`,
   exactly as if you'd set it by hand; it counts as a manual status dated at
   the meeting for rule 2.
   - With no THANK_YOU after it, it sets a one-off due date for the next
     business day. Logging a THANK_YOU clears it.
   - A later email or LinkedIn opener supersedes `CHATTED` and starts the
     normal cadence under rule 5.
8. **Snooze:** if `followUpOverrideAt` is set, it replaces whatever
   `nextFollowUpAt` rules 3–7 produced. This doesn't apply under
   `doNotContact`, which rule 1 already handles.

**As built (phase 2), details the rules above left open:**

- **A meeting counts as a manual CHATTED dated at the meeting.** The later of
  the explicit manual status and the latest meeting wins. Under a manual
  status the only reminder is a thank-you for a meeting that has no THANK_YOU
  after it and no opener after it.
- **Connection events don't supersede a manual status.** Only a newer opener
  does, as rule 2 says.
- **Messages with no opener, connection note or acceptance** (for example an
  inbound reply logged on its own) give REPLIED if they ever replied,
  otherwise NOT_CONTACTED, with no date.
- **A snooze on a contact with nothing due adds a "check in" reminder.** A
  snooze on something that is due keeps that item's label.
- **`maxFollowUps = 0` means no reminders.** The contact goes COLD
  `firstFollowUpBusinessDays` after the opener.
- **Loggable events are one table**, `MESSAGE_RULES`: outbound COLD,
  CONNECT_NOTE (LinkedIn only), MEETING (in person or other), FOLLOW_UP,
  THANK_YOU, REFERRAL_ASK and REPLY; inbound ACCEPTED (LinkedIn only) and
  REPLY. A logged message's words and date can be edited, but not its kind.
- **Business days** skip weekends only. Holidays are not handled.
Time-zone-aware day arithmetic reuses `calendarDate` and `calendarDaysBetween`
from `lib/alerts/build.ts`.

### Time-based recompute

Rule 5's move to `COLD` depends on time, not on a new message. The contacts
whose state can change with time are those with status `AWAITING_REPLY` or a
`nextFollowUpAt` set, tens of rows at most. They're recomputed in two places:

- **In the worker's digest job,** before it builds anything.
- **When `/network` loads.** The digest job only runs if the digest cron is
  configured, so the page recomputes the same set itself and stays correct
  with alerts turned off.

`nextFollowUpAt` itself never changes with time, so the Due list query
(`nextFollowUpAt <= end of today`) is correct even between recomputes; only
the COLD label can lag.

### Settings

Stored in the `Setting` table under the key `networking`, edited on
`/network/settings`, and checked with Zod when read:

```json
{
  "firstFollowUpBusinessDays": 5,
  "secondFollowUpBusinessDays": 7,
  "maxFollowUps": 2,
  "voiceExampleCount": 3,
  "voiceNotes": ""
}
```

`voiceNotes` is a hand-written description of how you write, capped at about
1,000 characters. It's included in every drafting prompt, so drafts sound like
you from the very first one. A good starting point is the rules you already
use for application writing: no em dashes, plain verbs, first person, specific
over general, and lead with the strongest point.

Changing the cadence settings triggers the same batch recompute.

---

## Drafting

`lib/networking/draft.ts` builds the prompt, calls the drafting client, and
checks the output. The prompt building is pure and tested against fixtures.

### Prompt inputs

| Input | Source | Notes |
|---|---|---|
| Your background | `Resume` extracted text | Truncated to a cap |
| Your voice notes | `networking.voiceNotes` setting | Always included when not empty |
| Contact | name, title, kind, `howMet`, `notes` | Your notes are the most useful part of the prompt |
| Role | linked `Listing`'s title, company, `postingText` | Optional; posting text is untrusted and truncated |
| Thread | earlier `OutreachMessage`s with this contact | For FOLLOW_UP, THANK_YOU and REFERRAL_ASK |
| Voice examples | your last N sent messages **of the same type** where `body` differs from `draftBody` | See below |
| Style guide | fixed system prompt, per message type | Length, tone, one clear ask |
| Your nudge | optional one-line instruction typed at draft time | e.g. "mention I use their API in my project" |

**What counts as an edit for voice examples.** `body` and `draftBody` are
compared after trimming, normalizing line endings and collapsing whitespace, so
a formatting-only change doesn't count. Only edits made in the app count. The
draft panel shows a short hint: "Edit here before sending — this is how drafts
learn your voice."

### Per-type constraints

| Type | Subject | Length | Enforced by |
|---|---|---|---|
| Cold email | yes | ~120–180 words | prompt |
| LinkedIn connection note | no | **≤ 300 characters** | code (retry once, then show with a warning) |
| Follow-up | "Re: …" of the original | ~50–80 words | prompt |
| Thank-you / referral ask | yes | ~80–150 words | prompt |

The 300-character limit is checked in code, not in the JSON schema. Structured
output schemas can't carry bounds; that's the same trap behind `clampAdjustment`
in scoring.

### Model and settings

- **Its own `drafting` config block**, `{ model: "claude-sonnet-5" }`, separate
  from scoring's `llm` block. There's no temperature setting on the
  subscription path.
- **A "Regenerate" button** requests a fresh draft.
- **No caching.** A draft is meant to be regenerated.
- **Output** is structured `{ subject?: string, body: string }`, checked with
  Zod, and rendered only into a `<textarea>`. It is never rendered as HTML.
- **When Draft is unavailable:**
  - It's disabled when Claude isn't connected, or when the contact is marked
    `doNotContact`.
  - It shows the reset time, when known, if a usage limit has been hit.
  - Hand-written messages still work in all of these cases.

### Send flow

1. On the contact page, pick the type (plus an optional listing and nudge),
   then click **Draft**.
2. Edit the draft in the app. This is what teaches the voice examples.
3. Click **Open in mail** (`mailto:` with the subject and body) or **Copy**.
   - Copy is the fallback: long bodies overflow mailto limits on some
     Windows clients, and mailto can't attach a resume.
   - LinkedIn notes get Copy only.
4. Click **Mark sent**. This saves an `OutreachMessage` with `body` (the final
   text) and `draftBody` (the original), sets `sentAt = now` (editable), and
   reruns the follow-up calculation.

Nothing is logged until you click Mark sent, so opening mailto and then not
sending leaves no false record.

### Privacy note

Drafting sends the contact's name, title and your notes on them to Anthropic
through your Claude account. Nothing is sent until you click Draft. The UI
shows a one-line note saying so. See also the privacy section under "Claude
access for drafting."

---

## UI

- **`/network`** (new nav entry)
  - **Due**: overdue and due-today items first, each with a one-click Draft
    button labeled for what's due:
    - "Draft follow-up" for a normal cadence step
    - "Draft thank-you" after a meeting
    - "Draft opener" after a LinkedIn connection is accepted; this defaults
      the channel to LinkedIn
  - **Contacts table**: search, and filters by company, kind and status. It
    uses the existing table's density and keyboard conventions.
    - `PENDING_CONNECTION` rows show how long ago the request was sent (for
      example "pending 23d"), so stale requests are easy to spot.
    - The table can be sorted by that age.
    - Withdrawing a request on LinkedIn needs no special handling here: leave
      the contact as it is, or mark it `doNotContact`.
  - **Add contact**: leads with company autocomplete against `Company`. A new
    name creates a row.
- **`/network/[id]`, the contact page**:
  - details and notes
  - a message timeline (in and out)
  - a "Log message" form for replies and hand-written messages
  - quick actions: **Mark connected** (logs ACCEPTED), **Log meeting** (logs
    MEETING), **Set status** (CHATTED/REFERRED) and **Snooze**
  - the drafting panel
  - a **Delete** button with a confirmation, since it's a hard delete
- **`/network/settings`**: the cadence settings, `voiceNotes`, and the Claude
  connection status.
- **Listing detail panel**: a "People at {Company}" section showing each
  person's status and the date of your last message, with a "Draft cold email"
  button that fills in the contact and listing.
- **Tracker cards**: a small contacts count for that company, plus a
  "Referred by …" badge when `referredByContactId` is set.

---

## Daily digest

`buildDailyDigest` in `lib/alerts/build.ts` gets a **"Follow-ups due"**
section, built right after the daily recompute. It lists contacts with
`nextFollowUpAt <= end of today`, capped at a handful, each linking to the
contact page. There is no new `AlertKind`; the section rides on the existing
digest's schedule.

- **No deduplication for follow-ups.** The section reflects the current due
  state each day and doesn't go through AlertLog deduplication. A follow-up
  you haven't acted on should keep appearing until it's handled or snoozed.
- **Follow-ups alone are enough to send.** A digest with no new listings but
  some follow-ups due should still send. Today `buildDailyDigest` returns null
  when no listings qualify ("an empty digest is noise") and takes only
  listings as input. It gets restructured to take the due contacts as a second
  input and return null only when **both** sections are empty. The per-day
  dedupe key stays as it is: one digest per day per channel, whatever it
  contains.

---

## Security and project conventions

- **Every new `app/**/actions.ts` calls `requireSession()` as its first
  statement.** `tests/auth/guard.test.ts` discovers these files on its own, so
  a missed one fails the suite.
- **All user input is checked with Zod** in the Server Actions:
  - emails
  - URLs (`linkedinUrl` must be an https LinkedIn URL, reusing `safeHttpUrl`)
  - length caps on notes, message bodies and `voiceNotes`
- **Contact data is third-party personal data** stored in Postgres. It's
  covered by the same backups and the same auth gate as everything else, with
  nothing new exposed. Claude Code session transcripts are turned off so the
  data isn't copied onto disk elsewhere.
- **Credential handling:**
  - Both the scoring key and the subscription token are env vars from the
    host stack's `.env`, like every other secret in the stack, and never
    stored in the database or the repo.
  - The app fails at boot if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is
    present.
  - The drafting client runs with an allowlisted environment.
- **The drafting client is locked down:** no tools, no MCP servers, a single
  turn, no filesystem settings, and an empty working directory.
- **Posting text inside the drafting prompt is untrusted.**
  - It's clearly delimited in the prompt.
  - With tools disabled and a single turn, the model can't act on anything.
  - The output is plain text in a textarea, so injected instructions can at
    worst produce a bad draft you'll read before sending.

---

## Testing

- **`tests/claude/draftClient.test.ts`**
  - `buildQueryOptions` produces no tools, a single turn, no settings sources,
    a custom system prompt and `claude-sonnet-5`
  - the environment passed to the SDK contains only allowlisted variables and
    never `ANTHROPIC_API_KEY`, `SCORING_ANTHROPIC_API_KEY` or
    `ANTHROPIC_AUTH_TOKEN`
  - errors map to the typed errors
  - no network is used; the SDK is faked
- **`tests/config/boot.test.ts`**: startup fails when `ANTHROPIC_API_KEY` or
  `ANTHROPIC_AUTH_TOKEN` is set.
- **`tests/scoring/*`**: the existing tests are updated for the renamed key,
  with a check that the key is passed to the client explicitly.
- **`tests/networking/followup.test.ts`** covers each rule above:
  - business-day boundaries (Friday send → Friday due, across time zones)
  - a reply stopping the cadence
  - `followUpsSent` counting only after the latest opener
  - COLD appearing only once `now` passes the final wait
  - doNotContact
  - a connection note staying pending with no date
  - acceptance setting a next-business-day "send opener" date
  - an opener clearing that date and starting the cadence
  - a meeting, then a thank-you, then a later opener
  - a manual status being superseded by a newer opener
  - snooze applying, and being cleared by a logged message
- **`tests/networking/draft.test.ts`** covers prompt building from fixtures:
  - voice examples selected per type, only edited ones, newest N
  - whitespace-only edits being ignored
  - `voiceNotes` included
  - posting text truncated
  - thread ordering
  - output parsing, including rejecting malformed JSON
  - the 300-character LinkedIn check with its retry and warning
  - no network, a fake client
- **`tests/networking/*.integration.test.ts`** covers:
  - mutations running the recompute in the same transaction
  - the daily recompute moving an overdue contact to COLD
  - a contact at a new company creating a `Company` row that ingestion later
    reuses
  - a hard delete cascading to messages
- **Guard test**: new actions are picked up automatically.

---

## Phases (stop for review after each)

1. **Contacts.**
   - Prerequisite: rename the scoring key to `SCORING_ANTHROPIC_API_KEY`, pass
     it explicitly, and add the boot check. This is small and can ship on its
     own.
   - schema and migration
   - company linking and normalization
   - contacts CRUD, including hard delete
   - the `/network` table and contact page (details only)
   - the "People at {Company}" panel on listings
   - the tracker card count
2. **Messages and follow-ups.**
   - `OutreachMessage`, the "Log message" form and the quick actions
   - the timeline
   - `computeFollowUpState` and its tests
   - the daily recompute
   - the Due list and the digest section
   - `/network/settings`
3. **Drafting.**
   - check the Agent SDK's current docs for subscription-auth use and option
     names before writing the client (the policy note above hasn't been
     verified against a primary source)
   - the drafting client (Agent SDK, pinned version), the token env var in
     compose, and transcripts turned off
   - packaging: the SDK starts a bundled Claude Code program, so under Next's
     `output: "standalone"` it needs `serverExternalPackages`, file-tracing
     includes for that program, and a writable config directory in the
     container. This works in dev; because the image has never been built, it
     joins the first-deploy checklist in `docs/DEPLOYMENT.md` as something to
     verify.
   - the "Claude not connected" state
   - confirming the claude.ai model-training setting is off
   - prompt builder and fixtures
   - all four message types
   - voice examples and `voiceNotes`
   - Draft/Regenerate, mailto/Copy/Mark sent
4. **Polish.**
   - `referredByContactId` on applications and its badge
   - contacts CSV import (reusing `/import` patterns)
   - docs: `ARCHITECTURE.md` sections, including the two Claude paths and
     token rotation, and a `CLAUDE.md` entry under architecture decisions
   - the company-name spelling issue, deferred from phase 1 review: a company
     created from a contact keeps the spelling typed there ("google") for
     good, because neither contacts nor ingestion rename an existing row.
     Likely fix: let ingestion replace the name on a row that has no listings
     yet.

Suggested owners:
- a general agent for `lib/networking/` and `lib/claude/` (neither belongs to
  ingestion or scoring)
- frontend-agent for the UI in phases 1–3
- reviewer-agent on each phase's diff

---

## Decisions made

1. **How Claude is reached:**
   - Drafting uses the Agent SDK on your Claude subscription, with Sonnet 5.
   - Scoring stays on API credits with its existing client.
   - The keys are kept apart by renaming, a boot check and an allowlisted
     environment.
2. **Networking bonus in scoring:** out of scope for now. It may be revisited
   later.
3. **Deleting contacts:** a real delete that cascades to messages.
   `doNotContact` covers keeping a record without contacting them.
4. **CHATTED contacts:** the cadence restarts on a new outbound COLD or
   REFERRAL_ASK (rule 2).
5. **In-person contacts:** logging a MEETING sets `CHATTED` automatically
   and prompts a thank-you the next business day. A later email or LinkedIn
   opener starts the normal cadence.
6. **Voice before any edits:** the `voiceNotes` setting.
7. **Cadence settings location:** `/network/settings`.
8. **LinkedIn connections:**
   - Everything is logged by hand; the app never connects to LinkedIn.
   - An accepted connection prompts an opener the next business day.
   - Pending requests show their age in the contacts table instead of getting
     reminders.

9. **Where the keys live:** env vars in the host `.env`, the same as every
   other secret in the stack, not Docker file secrets.
10. **Git:** a `feature/networking` branch. This plan is committed first, then
    one commit per phase after review. The scoring-key rename gets its own
    commit so it can ship alone.

## Open questions

None right now.
