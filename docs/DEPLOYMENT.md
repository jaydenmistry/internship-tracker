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
compiler traced into it. Discord alerts have really been delivered.

Authentication has **never** been exercised against a live Authelia — that part
is yours. What is verified is the app's side of it: with no identity header a
request is refused, with the wrong one it is refused, and with the right one it
is admitted (`tests/auth/guard.test.ts`).

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

Create the directories the bind mounts expect. Note they sit in
`internship-tracker-data`, **beside** the repo and not inside it: the repo
directory is the Docker build context, so a live Postgres data directory in
there would be tarred up and sent to the daemon on every rebuild — and could
end up in an image layer.

```bash
mkdir -p ~/docker/config/internship-tracker-data/{db,backups}
```

`config/` and `scripts/` are inside the repo already — they are part of it.

---

## Step 1 — point Authelia at it (labels only)

**You do not need to touch Authelia's `configuration.yml`.** This app uses
Authelia as a Traefik **forward-auth middleware**, not as an OIDC provider, so
there is no client to register and no signing key to generate. The middleware
label in `deploy/compose.tracker.yml` does the work.

Two things to check before you deploy.

### 1a. Find your middleware's name

```bash
docker inspect authelia | grep -o 'traefik.http.middlewares[^"]*'
```

You want the part before `.forwardauth`, plus its provider suffix — usually
`authelia@docker`, sometimes `authelia@file` if it is defined in Traefik's
dynamic config instead. That exact string goes in `TRACKER_AUTH_MIDDLEWARE`.

If nothing comes back, the middleware is defined in Traefik's file provider —
look in your Traefik dynamic config for `forwardAuth`.

### 1b. Check it forwards an identity header

The app identifies you from `Remote-Email`, falling back to `Remote-User`. Your
middleware must forward at least one:

```bash
docker inspect authelia | grep -o 'authResponseHeaders[^"]*'
```

You are looking for `Remote-User`, `Remote-Groups`, `Remote-Name`,
`Remote-Email` — the standard set. If `Remote-Email` is absent but
`Remote-User` is there, that is fine: set `TRACKER_ALLOWED_USER` to your
**username** rather than your email address.

If neither is forwarded, add them to the middleware definition. That is a
Traefik middleware change, not a `configuration.yml` change.

### 1c. Access control

Your `default_policy: one_factor` already covers `jobs.jmistry.com`, so nothing
is required here. If you want a stronger policy for this app specifically, add
a rule **above** your catch-all:

```yaml
    - domain: jobs.jmistry.com
      policy: two_factor
```

That is the one optional `configuration.yml` edit, and it is a hardening
choice, not a prerequisite.

---

## Step 2 — add the variables to the stack `.env`

Append the contents of [`deploy/env.tracker.example`](../deploy/env.tracker.example)
to `~/docker/stacks/apps/.env` and fill in every one marked REQUIRED:

| Variable | | Notes |
|---|---|---|
| `TRACKER_HOST` | REQUIRED | `jobs.jmistry.com` |
| `TRACKER_AUTH_MIDDLEWARE` | REQUIRED | From step 1a, e.g. `authelia@docker` |
| `TRACKER_ALLOWED_USER` | REQUIRED | Your `Remote-Email`, or username. Blank admits **nobody** |
| `TRACKER_DB_USER` / `_PASSWORD` / `_NAME` | REQUIRED | First boot only. Use `openssl rand -hex 32`: the value goes into `DATABASE_URL`, and base64's `/` would truncate it |
| `TRACKER_USER_AGENT_CONTACT` | REQUIRED | Scraper contact address |
| `TRACKER_AUTH_LOGOUT_URL` | optional | Authelia's logout URL, for the header link |
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

Do **not** copy the `services:` line itself. From the `networks:` block at the
bottom, copy **only the `tracker_net` entry** into your existing `networks:`
block — `apps_net` and `traefik_net` are already there.

`tracker_net` matters: the app trusts the identity headers Traefik forwards, and
that is only safe while Traefik is the only thing that can reach it. These four
services stay off `apps_net` so that nextcloud, portfolio, openclaw and factorio
cannot talk to the app directly and simply assert whatever identity they like.

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

All four `healthy`. `tracker-backup` takes its first dump immediately on
start (then sleeps for the interval), so it should go healthy within a minute
or two rather than after a day. If it is still `starting` or has gone
`unhealthy`, the dump is failing — check `docker compose logs tracker-backup`,
which will usually be a permissions problem on the bind-mounted `backups`
directory.

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
curl -s -o /dev/null -w "%{http_code}\n" https://jobs.jmistry.com/
curl -s -o /dev/null -w "%{http_code}\n" https://jobs.jmistry.com/api/applications/export
```

Both should be a redirect to Authelia (302/307) — that is the middleware doing
its job before the app ever sees the request. If either returns **200**, stop
and fix it: the middleware label is not applied, and the catalog, your
applications and your resume are readable by anyone.

Then confirm the app refuses a forged identity — this is the check that proves
the network isolation is real. From another container on the stack:

```bash
docker compose exec portfolio wget -qO- --header='Remote-Email: you@example.com' http://internship-tracker:3000/ 2>&1 | head -3
```

That must **fail to resolve or connect**. If it returns HTML, `tracker-app` is
still reachable off `tracker_net` and the header trust is unsafe — recheck the
`networks:` on all four services.

**6. Sign in.** Open `https://jobs.jmistry.com` in a browser. Authelia should
prompt, and after authenticating you land on the listings table with your
identity shown top-right. If you get a bare JSON `403` instead, Authelia
authenticated you but `TRACKER_ALLOWED_USER` does not match what it forwarded —
see step 6 below.

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

| Symptom | Cause | Fix |
|---|---|---|
| The page loads with **no Authelia prompt at all** | The middleware label is not applied | Check `TRACKER_AUTH_MIDDLEWARE` matches step 1a exactly, including the `@docker` / `@file` suffix. A wrong name makes Traefik skip the middleware silently |
| Traefik returns **500** on every request | The middleware name does not resolve | Same cause, different Traefik version. `docker logs traefik --tail 50` will name it |
| Authelia authenticates, then the app returns **`{"error":"this account is not the one…"}`** with 403 | `TRACKER_ALLOWED_USER` does not match the forwarded identity | See what is actually being forwarded, below. Set the variable to exactly that, then `docker compose up -d tracker-app` |
| The app returns **`{"error":"authentication required"}`** with 401 | No identity header arrived | The middleware is not forwarding one — check `authResponseHeaders` (step 1b) |
| Everything 401s including your own browser | `TRACKER_ALLOWED_USER` is blank | It fails closed on purpose. An unset allowlist admits nobody |

To see exactly what Authelia is forwarding, ask the app to echo it back — it
logs nothing sensitive because the header IS the identity:

```bash
docker compose logs tracker-app --tail 50
```

Or check Authelia directly:

```bash
docker logs authelia --tail 50
```

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

## Optional: isolate the tracker on its own network

As written, all four services sit on `apps_net`, matching the rest of your
stack. That means `tracker-db:5432` and the worker's `:8081` are reachable
from every other container on that network — nextcloud, portfolio,
`openclaw-*`, factorio. Nothing is exposed to the LAN or the internet, but
`POST http://tracker-worker:8081/refresh` is unauthenticated and starts a full
outbound ingest cycle, so any container on `apps_net` can trigger it.

If you would rather they could not, give the tracker its own network. In the
`networks:` block at the bottom of your compose.yml:

```yaml
  tracker_net:
    name: tracker_net
    internal: true
```

Then on all four tracker services, replace `- apps_net` with `- tracker_net`.
Keep `- traefik_net` on `tracker-app` — that is how Traefik reaches it, and it
is the only service that needs reaching.

Nothing else in the stack refers to the tracker, so nothing breaks. The one
thing you give up is being able to reach `tracker-db` from another container
on `apps_net`, which nothing does today.

---

## The security model, in one paragraph

Authelia authenticates every request as a Traefik middleware and forwards
`Remote-Email` / `Remote-User`. The app trusts those headers and checks them
against `ALLOWED_USER`. It has **no session of its own** and no login page —
there is nothing here to sign out of, which is why the header's "Sign out" link
just points at Authelia.

Trusting a request header is only safe while the request cannot come from
anywhere but Traefik. That is what `tracker_net` is for: `tracker-app` is on
`traefik_net` and an internal `tracker_net`, and **not** on the shared
`apps_net`. Anything that can open a socket to `internship-tracker:3000`
directly can assert any identity it likes. So:

- never add `ports:` to `tracker-app`
- never put it back on `apps_net`
- if you later expose it through a second reverse proxy, that proxy must strip
  client-supplied `Remote-*` headers, exactly as Traefik's forward-auth does

The app still re-checks the header inside every Server Action
(`lib/auth-guard.ts`), so a mistake in the proxy matcher costs a 401 rather
than the catalog. Step 5 has a command that proves the isolation from a
neighbouring container — run it once.

---

## What is unverified

Nothing here has been built or run. In rough order of how likely each is to be
the thing that bites:

1. **The image has never been built.** Not one `docker build`. Every stage and
   `COPY --from` is reasoned about, not observed.
2. ~~**One image, two commands.**~~ **Retired.** The worker bundle's external
   set was resolved from its actual esbuild metafile — `@anthropic-ai/sdk`,
   `@prisma/adapter-pg`, `@prisma/client`, `cheerio`, `node-cron`,
   `nodemailer`, `robots-parser`, `zod` — and every one is in `dependencies`,
   so the production-only install the runtime copies first does contain them.
   The Prisma query compiler resolves as a package path, not a file-relative
   `.wasm`, so the bundle finds it. What remains unobserved is only the
   `COPY`-merge of the two `node_modules` trees (item 3).
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
10. **Nothing has been tested against a live Authelia.** The app's own side is
    covered by `tests/auth/guard.test.ts` — no header refused, wrong identity
    refused, right identity admitted via either header — and the gate was
    probed hard against a production build (`..` and `%2e%2e` traversal through
    the matcher's exclusions, case-varied paths, trailing slashes, an RSC
    request, a bare POST; Next normalises the path before the proxy sees it, so
    none slipped past, and `public/` files refused with them). What is
    unverified is the middleware wiring: whether your Authelia forwards the
    header this app reads, and under the name you configured.
11. **SMTP has never contacted a real server.** Discord has.
12. **The build host needs outbound internet** — `next/font/google` downloads
    fonts at build time.
