# Deploying the internship tracker

**None of this has ever been run.** There is no container runtime on the
machine this was written on, so no image has been built and the stack has never
started. Every step below is reasoned from the code and from your stack's
conventions, not observed. [What is unverified](#what-is-unverified) at the
bottom lists exactly where to look when something does not work.

What *has* been verified: against a real PostgreSQL 17 server, `prisma migrate
deploy` applies all migrations from empty with no drift afterwards, the raw-SQL
rank pass targets the right schema, and `backup.sh` / `restore.sh` round-trip a
database. `next build` produces standalone output with the Prisma WASM query
compiler traced into it. Discord alerts have really been delivered. And the
**redirect URI in step 1b is confirmed, not assumed** — a running server with
this exact configuration advertises
`https://jobs.jmistry.com/api/auth/callback/oidc` as its callback.

Signing in has **never** been done end to end — it needs a live Authelia, which
is you.

- **Target host:** hp-envy
- **Stack:** `~/docker/stacks/apps/compose.yml` (+ its `.env`)
- **App directory on the host:** `${CONFIG_ROOT}/internship-tracker`
- **Public URL:** `https://jobs.jmistry.com`

---

## Step 0 — put the code on the host

The stack builds the image from the repo directory, exactly as `portfolio`
does, so the repo has to live under `CONFIG_ROOT`.

```bash
git clone <this-repo> ~/docker/config/internship-tracker
```

If `CONFIG_ROOT` is not `~/docker/config`, clone to `$CONFIG_ROOT/internship-tracker`
instead — the path must match, because `compose.yml` refers to it by variable.

Create the directories the bind mounts expect. Docker would create them as
**root** on first run, which breaks the backup sidecar:

```bash
mkdir -p ~/docker/config/internship-tracker/{db,backups}
```

`config/` and `scripts/` already exist — they are part of the repo.

---

## Step 1 — register the OIDC client in Authelia

This is the step that will cost you an hour if you get it wrong, because every
mistake surfaces as the same unhelpful word: *Configuration*.

### 1a. Generate the client secret

Authelia stores a **hash**; the app needs the **plaintext**. You need both, and
you only get to see the plaintext once.

```bash
docker run --rm authelia/authelia:latest authelia crypto hash generate pbkdf2 --variant sha512 --random --random.length 72 --random.charset rfc3986
```

It prints two lines:

- `Random Password: ...` → this is the **plaintext**. Put it in the stack `.env`
  as `TRACKER_OIDC_SECRET`.
- `Digest: $pbkdf2-sha512$...` → this is the **hash**. Put it in Authelia's
  `configuration.yml` as `client_secret`.

If you are running Authelia as a container already, use that container instead
of pulling a fresh one:

```bash
docker exec -it authelia authelia crypto hash generate pbkdf2 --variant sha512 --random --random.length 72 --random.charset rfc3986
```

### 1b. Add the client to Authelia's `configuration.yml`

Under `identity_providers.oidc.clients`, add:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: internship-tracker
        client_name: Internship Tracker
        # The DIGEST from step 1a, not the plaintext.
        client_secret: '$pbkdf2-sha512$310000$...'
        public: false
        authorization_policy: two_factor
        consent_mode: implicit
        redirect_uris:
          - https://jobs.jmistry.com/api/auth/callback/oidc
        scopes:
          - openid
          - profile
          - email
        grant_types:
          - authorization_code
        response_types:
          - code
        # Must match what the app sends. Both sides are pinned to this
        # explicitly — see lib/auth.config.ts.
        token_endpoint_auth_method: client_secret_basic
```

**The redirect URI must be this exact string:**

```
https://jobs.jmistry.com/api/auth/callback/oidc
```

Authelia compares redirect URIs byte for byte. No trailing slash, `https` not
`http`, and the last path segment is `oidc` — that is the provider's internal
id, deliberately named after the protocol rather than after Authelia so that
swapping identity providers later does not require re-registering the client.

Notes on the choices above:

- **`consent_mode: implicit`** skips the "do you allow this app?" screen. This
  is a single-user app you own; the consent screen adds a click and tells you
  nothing. Use `explicit` instead if you want the prompt.
- **`authorization_policy: two_factor`** requires your second factor. Drop to
  `one_factor` only if you have a reason.
- **`email` scope is not optional.** The app's allowlist is an email
  comparison. Without the scope, Authelia returns a token with no email claim,
  the allowlist refuses it, and you get *"That account is not the one this
  tracker is configured for"* — while looking at your own account.
- If your Authelia enforces a **claims policy**, make sure the `email` claim is
  actually released to this client.

Restart Authelia and confirm the secret parsed:

```bash
docker logs authelia --tail 50
```

### 1c. Confirm discovery works

```bash
curl -s https://auth.jmistry.com/.well-known/openid-configuration | head -c 400
```

That must return JSON. Whatever origin makes this work is exactly what goes in
`TRACKER_OIDC_ISSUER` — **no trailing slash, no path**.

---

## Step 2 — add the variables to the stack `.env`

Append the contents of [`deploy/env.tracker.example`](../deploy/env.tracker.example)
to `~/docker/stacks/apps/.env` and fill in every one marked REQUIRED:

| Variable | | Notes |
|---|---|---|
| `TRACKER_HOST` | REQUIRED | `jobs.jmistry.com` |
| `TRACKER_DB_USER` / `_PASSWORD` / `_NAME` | REQUIRED | First boot only — see step 6 |
| `TRACKER_AUTH_SECRET` | REQUIRED | `openssl rand -base64 32` |
| `TRACKER_OIDC_ISSUER` | REQUIRED | Root origin, no trailing slash |
| `TRACKER_OIDC_ID` | REQUIRED | Must equal `client_id` |
| `TRACKER_OIDC_SECRET` | REQUIRED | The **plaintext** from step 1a |
| `TRACKER_ALLOWED_EMAIL` | REQUIRED | Blank admits **nobody** |
| `TRACKER_USER_AGENT_CONTACT` | REQUIRED | Scraper contact address |
| `TRACKER_ANTHROPIC_API_KEY` | optional | Unset = deterministic scoring only |
| `TRACKER_DISCORD_WEBHOOK_URL` | optional | Unset = channel reports itself off |
| `TRACKER_SMTP_*` | optional | Never tested against a real server |
| `TRACKER_*_CRON`, `TRACKER_BACKUP_*` | optional | Defaults are sensible |

`CONFIG_ROOT`, `TZ`, `APPS_NET` and `TRAEFIK_NET` are already in that file and
are reused. Do not redefine them.

---

## Step 3 — add the services to the stack

Copy the four service blocks from
[`deploy/compose.tracker.yml`](../deploy/compose.tracker.yml) into
`~/docker/stacks/apps/compose.yml`, under its existing `services:` key, at the
same indentation as `portfolio`.

Do **not** copy the `services:` line itself or the `networks:` block at the
bottom of that file — your compose.yml already has both.

The four services are `tracker-db`, `tracker-app`, `tracker-worker` and
`tracker-backup`. They are named `tracker-*` because your stack already has a
service called `app` (Nextcloud) and one called `db` (nextcloud-db).

Check it parses before starting anything:

```bash
cd ~/docker/stacks/apps && docker compose config > /dev/null && echo OK
```

That command also resolves every `${VAR}`, so it is the fastest way to catch a
missing one.

---

## Step 4 — bring it up

```bash
cd ~/docker/stacks/apps && docker compose up -d --build tracker-db tracker-app tracker-worker tracker-backup
```

The first build takes several minutes (it installs dependencies twice — once
with dev dependencies to build, once without for the runtime — and runs
`next build`).

Start order is enforced by healthchecks: `tracker-db` must be healthy before
`tracker-app` starts, and `tracker-app` must be healthy before `tracker-worker`
does. **`tracker-app` applies the database migrations on startup** (it is the
only container with `RUN_MIGRATIONS=1`; the worker shares the same image and
must not race it).

---

## Step 5 — verify, in this order

Do these in sequence. Each one rules out everything below it.

**1. The containers are up and healthy.**

```bash
docker compose ps
```

All four `healthy`. `tracker-backup` will show `starting` for the first couple
of minutes — it is healthy only once a dump exists, and the first one is not
taken until a full interval has passed (24h by default). To stop waiting, take
one by hand — see step 7.

**2. Migrations actually applied.**

```bash
docker compose logs tracker-app | grep entrypoint
```

Expect `applying pending migrations` then `migrations applied`. If the
container is restart-looping, this is where it says why.

**3. The app answers, inside the network.**

```bash
docker compose exec tracker-app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
```

Expect `{"ok":true}`. `/api/health` is the one unauthenticated route.

**4. Traefik routes it and TLS is issued.**

```bash
curl -sI https://jobs.jmistry.com/api/health | head -3
```

Expect `HTTP/2 200`. A 404 here is Traefik, not the app — check that
`traefik.docker.network` matches and that `tracker-app` is on `traefik_net`.

**5. The gate is closed.**

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -H "Accept: text/html" https://jobs.jmistry.com/
curl -s -o /dev/null -w "%{http_code}\n" https://jobs.jmistry.com/api/applications/export
```

Expect `307 https://jobs.jmistry.com/signin` and `401`. If either returns 200,
**stop and fix it before going further** — that is the whole catalog, your
applications and your resume, readable by anyone.

**6. Sign in.** Open `https://jobs.jmistry.com` in a browser. You should land on
`/signin`, get redirected to Authelia, and come back signed in. If the page
instead lists missing environment variables, it is telling you exactly which
ones — go back to step 2.

**7. The worker is scheduled.**

```bash
docker compose logs tracker-worker | head -20
```

Expect `listening on :8081` and the cron schedules. An invalid cron expression
disables that one job and logs it, rather than killing the container.

**8. A real ingest cycle.** Either wait for `TRACKER_INGEST_CRON`, or trigger
one now from inside the network:

```bash
docker compose exec tracker-worker node -e "fetch('http://127.0.0.1:8081/refresh',{method:'POST'}).then(r=>r.text()).then(console.log)"
```

This takes a few minutes and makes outbound requests. Watch it with
`docker compose logs -f tracker-worker`.

---

## Step 6 — if sign-in fails

Work down this list; it is ordered by how often each one is the cause.

| Symptom | Cause | Fix |
|---|---|---|
| `/signin` lists missing variables | Those are literally unset in the container | Check the stack `.env`, then `docker compose up -d` to recreate — editing `.env` alone does nothing to a running container |
| "Sign-in failed" / `error=Configuration` | Discovery unreachable, or issuer wrong | `curl https://auth.jmistry.com/.well-known/openid-configuration`. Remove any trailing slash from `TRACKER_OIDC_ISSUER` |
| Authelia says **invalid redirect_uri** | Byte mismatch | It must be exactly `https://jobs.jmistry.com/api/auth/callback/oidc`. Check for a trailing slash, `http`, or a stale hostname |
| Authelia says **invalid client secret** | `.env` has the hash, or Authelia has the plaintext | `.env` gets the plaintext; `configuration.yml` gets the `$pbkdf2-sha512$...` digest. They are not interchangeable |
| Authelia accepts the login, then the app errors and dumps you back at `/signin` | `token_endpoint_auth_method` differs between the two sides | Both must say `client_secret_basic`. The app pins it in `lib/auth.config.ts`; the client registration must match. This one fails *after* a successful login, so it does not look like an auth problem |
| **"That account is not the one this tracker is configured for"** | The email claim did not arrive, or does not match | Confirm `email` is in the client's `scopes` and released by any claims policy; confirm `TRACKER_ALLOWED_EMAIL` matches your Authelia email exactly (case is ignored, whitespace is trimmed) |
| Redirect loop between app and Authelia | Cookie not surviving | `AUTH_URL` must be the `https://` origin with no trailing slash, and Traefik must terminate TLS |
| Signed in, then signed out again immediately | `TRACKER_AUTH_SECRET` changed, or differs between restarts | Set it to a fixed value in `.env` |
| Authelia says **invalid redirect_uri**, and the URI it reports has an unexpected prefix | `TRACKER_HOST` was given as a URL with a path, so `AUTH_URL` carries one | next-auth derives its base path from `AUTH_URL`'s pathname: a path there moves the callback from `/api/auth/callback/oidc` to `/<that path>/callback/oidc`. `TRACKER_HOST` must be a bare hostname — `jobs.jmistry.com`, not `https://jobs.jmistry.com/anything` |

Useful detail:

```bash
docker compose logs tracker-app --tail 100 | grep -i auth
docker logs authelia --tail 100
```

---

## Step 7 — backups

**Where dumps land:** `${CONFIG_ROOT}/internship-tracker/backups`, on the host,
as `internship_tracker-<UTC timestamp>.dump` — custom-format `pg_dump` output.

`tracker-backup` takes one every `TRACKER_BACKUP_INTERVAL_SECONDS` (24h
default). Each dump is written under a `.partial-` name and renamed only after
`pg_restore --list` confirms it is readable, so a dump interrupted halfway is
never mistaken for a usable backup. Retention deletes dumps older than
`TRACKER_BACKUP_RETENTION_DAYS` (14) but always keeps at least
`TRACKER_BACKUP_KEEP_MIN` (7), so a fortnight of downtime cannot empty the
directory.

### Take one right now

```bash
cd ~/docker/stacks/apps && docker compose exec tracker-backup sh /scripts/backup.sh
```

### List what you have

```bash
cd ~/docker/stacks/apps && docker compose run --rm --entrypoint sh tracker-backup /scripts/restore.sh --list
```

`--entrypoint sh` matters: the service's entrypoint is `sh -c`, which would
swallow the arguments.

### Restore one

**This is destructive — it drops and recreates every object in the database.**
Stop the app and worker first, or a write landing mid-restore is lost and can
leave a half-applied schema.

```bash
cd ~/docker/stacks/apps && docker compose stop tracker-app tracker-worker
```

```bash
cd ~/docker/stacks/apps && docker compose run --rm --entrypoint sh tracker-backup /scripts/restore.sh /backups/internship_tracker-20260920T193410Z.dump --confirm
```

Without `--confirm` it prints what it would do and stops. Then:

```bash
cd ~/docker/stacks/apps && docker compose start tracker-app tracker-worker
```

### Verifying a restore

```bash
cd ~/docker/stacks/apps && docker compose exec tracker-db psql -U tracker -d internship_tracker -c 'select (select count(*) from "Listing") as listings, (select count(*) from "Application") as applications, (select count(*) from _prisma_migrations) as migrations'
```

Listings in the thousands, and the migration count matching the number of
directories in `prisma/migrations/`. If migrations is 0, you restored into the
wrong database.

### Testing a restore without destroying anything

Point `PGDATABASE` at a scratch database instead:

```bash
cd ~/docker/stacks/apps && docker compose exec tracker-db createdb -U tracker restore_test
```

```bash
cd ~/docker/stacks/apps && docker compose run --rm --entrypoint sh -e PGDATABASE=restore_test tracker-backup /scripts/restore.sh /backups/<file>.dump --confirm
```

---

## Changing the database password later

`TRACKER_DB_PASSWORD` initialises Postgres on **first boot only**. Editing it
afterwards changes what the app *sends*, not what the server *expects*, and the
app then cannot connect. To actually change it:

```bash
cd ~/docker/stacks/apps && docker compose exec tracker-db psql -U tracker -d internship_tracker -c "ALTER USER tracker WITH PASSWORD 'new-password'"
```

Then update `.env` and `docker compose up -d tracker-app tracker-worker`.

---

## Optional: Traefik forward-auth in front

The app has **its own session** — Authelia OIDC, one allowed address, enforced
both in `proxy.ts` and again inside every Server Action. It is not relying on
anything in front of it, and you do not need forward-auth for it to be safe.

If you want Authelia in front as a second layer anyway, add its middleware to
the router:

```yaml
      - "traefik.http.routers.internship-tracker.middlewares=authelia@docker"
```

(Use whatever name your existing Authelia middleware has.)

Two consequences before you do:

- **You will sign in twice** on a cold session — once at the forward-auth
  prompt, once at the app's own OIDC redirect. Setting the app client's
  `consent_mode: implicit` (step 1b) makes the second one invisible.
- **`/api/health` would be gated too**, and Docker's healthcheck runs inside
  the container rather than through Traefik, so the healthcheck itself is
  unaffected. But any external uptime monitor hitting that URL would start
  seeing redirects.

---

## What is unverified

Nothing here has been built or run. In rough order of how likely each is to be
the thing that bites:

1. **The image has never been built.** Not one `docker build`. Every stage and
   `COPY --from` is reasoned about, not observed.
2. **One image, two commands.** The runtime installs full production
   dependencies *and* overlays Next's standalone output, so the worker has its
   whole closure rather than only what Next traced for the app. Both trees come
   from one lockfile, so overlapping packages are identical — but the merge has
   never been observed. If the worker dies on a missing module, that is this.
3. **The staged Prisma CLI merged into standalone's `node_modules`** relies on
   `COPY` merging into an existing directory. Never observed.
4. **Image size is an estimate.** Shipping one image for both containers means
   the worker carries Next and the app carries the worker bundle. Fine on a
   home server; if it matters, the Dockerfile splits back into two targets
   easily.
5. **`docker compose config` has never run against your real file.** Variable
   interpolation was simulated, not executed.
6. **Traefik was never exercised.** Router name, `websecure`, `cf`, and
   `traefik.docker.network` are copied from your `portfolio` service's form,
   not confirmed. A wrong entrypoint surfaces as a Traefik 404, not an error in
   this stack.
7. **The healthchecks use `node -e fetch`, not `wget`** as `portfolio` does,
   because the runtime image is `node:22-bookworm-slim` and ships neither
   `wget` nor `curl`. The form is copied from your `openclaw-gateway` service.
8. **The bind-mounted Postgres data directory.** The official image chowns it
   on first init while running as root, the same way your `nextcloud-db`
   MariaDB mount works — but Postgres is stricter about permissions than
   MariaDB, and this specific mount has not been tested.
9. **busybox `find -mmin`** in `scripts/backup-healthcheck.sh`. Both exit
   paths were tested here, but on macOS `find`, not busybox. The backup
   sidecar runs as root (the entrypoint is overridden), so the dumps it writes
   into the bind mount are root-owned — which is fine for restoring through
   the same container, but means you will need `sudo` to delete one by hand.
10. **Sign-in has never completed.** Only the refusal path is verified.
11. **SMTP has never contacted a real server.** Discord has.
12. **The build host needs outbound internet** — `next/font/google` downloads
    fonts at build time.
