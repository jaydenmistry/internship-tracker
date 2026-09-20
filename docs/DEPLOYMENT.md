# Deployment, backups and restore

Phase 5 infrastructure: how the containers are built, what Traefik routes, how
migrations run, where database dumps land, and how to get one back.

> **Status: written, never executed.** No part of this document has been run
> against a real Docker daemon — there was no container runtime on the machine
> where it was written. The first deploy is the first test. The
> [First-deploy checklist](#first-deploy-checklist) lists what to watch.

---

## The four services

| Service    | Image                    | Network(s)         | Exposed?                                   |
| ---------- | ------------------------ | ------------------ | ------------------------------------------ |
| `postgres` | `postgres:17-alpine`     | `private`          | No — no published port                     |
| `app`      | built, `--target app`    | `private`, Traefik | **Yes**, `https://$APP_DOMAIN` via Traefik |
| `worker`   | built, `--target worker` | `private`          | No — no port, no Traefik label             |
| `backup`   | `postgres:17-alpine`     | `private`          | No                                         |

All four have healthchecks: `pg_isready` for `postgres`, `GET /api/health` for
`app`, `GET /healthz` for `worker`, and a dump-freshness check for `backup`.

`app` is the only service on the Traefik network and the only one carrying
`traefik.*` labels. That is what keeps the worker's `POST /refresh` — which is
unauthenticated and kicks off a full ingestion cycle — reachable only as
`http://worker:8081/refresh` from inside the compose network.

### Why one image with two targets

`app` and `worker` share everything under `lib/`. Building them from one
`Dockerfile` with two final stages means they cannot drift apart on the scoring
engine, the dedup rules, or the Prisma client.

### How the worker runs in production

`worker/index.ts` runs under `tsx` in development, but `tsx` is a
devDependency — an `npm ci --omit=dev` runtime install does not have it, and
promoting it would mean regenerating `package-lock.json`. So the image
precompiles the worker instead: `scripts/build-worker.mjs` uses esbuild (already
present, as a dependency of `tsx`) to bundle `worker/index.ts` and its
first-party imports into a single `dist/worker.mjs`. Real runtime packages
(`@prisma/client`, `cheerio`, `nodemailer`, …) stay external and are resolved
from the production install; only `dotenv` is inlined, because it is the one
devDependency the worker imports.

The build fails loudly if the bundle ends up needing a package that is not in
`dependencies` — better a red build than a container that crash-loops on
`ERR_MODULE_NOT_FOUND`.

---

## Migrations

`prisma migrate deploy` runs in `docker/app-entrypoint.sh`, before `server.js`
starts. If it fails the entrypoint exits non-zero, so the container stops rather
than serving against a schema its client does not match; Docker's restart policy
retries it.

The `worker` service waits on `app: condition: service_healthy`, and `app` only
reports healthy once migrations have finished and `/api/health` answers. That
ordering is the only thing preventing an ingestion cycle against an unmigrated
schema.

The Prisma CLI is a devDependency, so it is not in the app's production install.
`scripts/stage-prisma-cli.mjs` computes its dependency closure from the
installed `package.json` files and stages it into the image, where it is merged
into the traced `node_modules`. Hand-listing those packages in the `Dockerfile`
would rot the first time Prisma changed a dependency.

> ### Read this before the first production deploy
>
> The development database was built with `prisma db push`, not with migrations,
> so it has **no `_prisma_migrations` table** and `migrate deploy` has never run
> against it. A fresh production database is the first real exercise of the
> migration history.
>
> The history in `prisma/migrations/` was checked to be complete from empty —
> every model, enum and scalar field in `schema.prisma` appears in the migration
> SQL — but "the SQL mentions it" is not "the SQL applies cleanly". Watch the
> first `app` container's logs.
>
> If you ever point this at the **existing** development database, `migrate
> deploy` will try to create tables that already exist and fail. That database
> has to be baselined first (`prisma migrate resolve --applied <name>` for each
> migration, oldest first), or dumped and restored into a clean one.

---

## Configuration that changes without a redeploy

`./config` is bind-mounted read-only into both `app` and `worker` at
`/app/config`. Edit `config/scoring.json` on the host and the next scoring run
picks it up — the file is re-read and re-hashed every run, and a changed hash is
what marks scores stale. No restart, no rebuild.

It is mounted as a **directory**, not as a single file, on purpose: a
single-file bind mount pins an inode, so any editor that writes-and-renames
(vim, VS Code, most of them) would leave the containers reading the old contents
forever.

Alert thresholds are not here at all — they live in the `Setting` table and are
edited from `/alerts`. Everything else is an environment variable and needs the
container recreated; see `.env.example`, where each variable is tagged.

---

## Backups

### Where dumps land

In the named Docker volume **`backups`**, mounted at `/backups` in the `backup`
container. Filenames are date-stamped UTC:

```
/backups/internship_tracker-20260920T031500Z.dump
```

They are `pg_dump -Fc` archives — Postgres' compressed custom format, restorable
whole or selectively with `pg_restore`.

To find the volume on the host (Dokploy sets its own compose project name, so
the prefix may not be `internship-tracker_`):

```bash
docker volume ls | grep backups
docker volume inspect <name> --format '{{ .Mountpoint }}'
```

To list them without touching the host filesystem:

```bash
docker compose run --rm --entrypoint sh backup /scripts/restore.sh --list
```

(`--entrypoint sh` is needed because the `backup` service's own entrypoint is
`sh -c`, which swallows the arguments you pass it.)

### How they are taken

The `backup` service runs `scripts/backup.sh` in a loop: once at container
start, then every `BACKUP_INTERVAL_SECONDS` (default daily). It uses the same
`postgres:17-alpine` image as the server, because `pg_dump` refuses to dump from
a server newer than itself — pinning both to one tag means a Postgres upgrade
cannot silently break backups.

Two details worth knowing:

- Each dump is written as `.partial-*.dump` and renamed only after `pg_restore
  --list` confirms it is readable, so a dump killed halfway through is never
  mistaken for a usable backup.
- Retention deletes dumps older than `BACKUP_RETENTION_DAYS`, but always keeps
  the newest `BACKUP_KEEP_MIN` regardless of age. A fortnight of downtime cannot
  prune the volume to nothing.
- The service has a healthcheck that goes **unhealthy once no dump has been
  written for two whole intervals**. Nothing depends on the `backup` service, so
  this is a signal in `docker compose ps` rather than something that takes the
  stack down — but it is the only symptom a silently-wedged backup loop has.

A backup is only real once you have restored it. Do the drill below at least
once, before you need it.

---

## Restoring

`pg_restore` here is **destructive**: it drops and recreates every object in the
target database. Nothing in this procedure is reversible, so read it through
first.

### 1. Stop the writers

```bash
docker compose stop app worker
```

Leave `postgres` running. A write landing mid-restore is lost, and can leave a
half-applied schema that looks fine until the next query.

### 2. Pick a dump

```bash
docker compose run --rm --entrypoint sh backup /scripts/restore.sh --list
```

Newest first. `.partial-*` files are refused by the restore script.

### 3. Restore it

```bash
docker compose run --rm --entrypoint sh backup \
  /scripts/restore.sh /backups/internship_tracker-20260920T031500Z.dump --confirm
```

Without `--confirm` the script prints what it *would* do and exits 1. It also
verifies the archive is readable **before** dropping anything — a restore that
destroys the live data and then discovers the dump is corrupt is the worst
possible outcome.

### 4. Bring the app back

```bash
docker compose up -d app worker
```

`app` re-runs `prisma migrate deploy` on start. If the dump predates a
migration, that is where it gets applied.

### Verifying a restore

Do not trust "no errors" — check the data.

**Row counts.** A restored catalog should look like the one you dumped:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '
  SELECT
    (SELECT count(*) FROM "Listing")     AS listings,
    (SELECT count(*) FROM "Company")     AS companies,
    (SELECT count(*) FROM "Application") AS applications,
    (SELECT count(*) FROM "IngestRun")   AS ingest_runs;'
```

**Migration state.** Every migration applied, none failed:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '
  SELECT migration_name, finished_at, rolled_back_at
  FROM _prisma_migrations ORDER BY started_at;'
```

**The app agrees.** `/api/health` checks database connectivity, and the listings
table is the broadest read path in the app:

```bash
docker compose ps            # app healthy, worker healthy
docker compose logs app --tail=50
```

Then open `https://$APP_DOMAIN` and confirm the listings table populates, ranks
are present, and `/tracker` shows your applications.

### Rehearsing a restore without risking the live database

Restore into a scratch database instead, by overriding `PGDATABASE`:

```bash
docker compose exec postgres createdb -U "$POSTGRES_USER" restore_drill
docker compose run --rm -e PGDATABASE=restore_drill --entrypoint sh backup \
  /scripts/restore.sh /backups/<file>.dump --confirm
docker compose exec postgres psql -U "$POSTGRES_USER" -d restore_drill \
  -c 'SELECT count(*) FROM "Listing";'
docker compose exec postgres dropdb -U "$POSTGRES_USER" restore_drill
```

This is the only way to find out whether your backups actually work that does
not involve finding out the hard way.

---

## First-deploy checklist

Nothing below has been executed. In rough order of likelihood of biting:

1. **`next build` reaching the network.** `app/layout.tsx` uses
   `next/font/google`, which downloads font files at build time. The build host
   needs outbound internet.
2. **Prisma client runtime tracing.** The app image relies on Next's
   `output: "standalone"` tracer to pull `@prisma/client`'s WASM query compiler
   into the traced `node_modules`. If the app starts and then fails on a missing
   `query_compiler_fast_bg.postgresql.*`, force it in with
   `outputFileTracingIncludes` in `next.config.ts`.
3. **The first `migrate deploy`.** See the warning above. Watch
   `docker compose logs app` on the first boot.
4. **Traefik entrypoint and certresolver names.** `TRAEFIK_ENTRYPOINT` and
   `TRAEFIK_CERT_RESOLVER` must already exist in the Traefik static config;
   Dokploy's defaults are `websecure` and `letsencrypt`. A wrong name shows up
   as a 404 from Traefik, not as an error in this stack.
5. **`TRAEFIK_NETWORK` must already exist.** It is declared `external: true`,
   so compose will not create it.
6. **`/api/health` must be unauthenticated.** The app's healthcheck calls it
   from inside the container. If auth ever covers it, the container is marked
   unhealthy forever and the worker never starts.
7. **Image size.** The app image carries the staged Prisma CLI so it can run
   migrations — roughly 245MB of tooling on top of the standalone output. If
   that ever matters, the clean fix is to move `prisma` and `tsx` into
   `dependencies`, regenerate `package-lock.json`, and drop
   `scripts/stage-prisma-cli.mjs` in favour of `npm ci --omit=dev`.
