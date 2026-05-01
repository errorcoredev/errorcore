# Contributing

This document covers local development. For the SDK's user-facing API,
see [README.md](README.md) and [SETUP.md](SETUP.md).

## Build and test

```bash
npm install
npm run build       # tsc compile
npm test            # full vitest run
npm run coverage    # coverage report under coverage/
```

`npx tsc -p tsconfig.json --noEmit` is a fast type-check without
emitting `dist/`. Run it after every meaningful edit.

## Test layout

- `test/unit/` — unit suites. Should run in well under 30s end-to-end.
- `test/integration/` — integration suites that touch a real driver,
  a real Next.js build, or a real ALS lifecycle. The mongodb suite
  uses `mongodb-memory-server` (in-process), the ioredis suite uses an
  in-process RESP-2 stub server, and `pg` / `mysql2` suites are
  opt-in (see below).

`npm test` runs the unit suites plus the always-on integration suites
(mongodb, ioredis). It does NOT run the opt-in pg/mysql2 suites or the
Next.js smoke harness.

## Opt-in database driver tests

The `pg` and `mysql2` integration suites are skipped by default because
they need a reachable database server. Engineers can run them locally
in three ways. Pick whichever is easiest on your machine.

### Postgres — `EC_INTEGRATION_PG=1`

```bash
# Option A: docker
docker run --rm -d --name errorcore-pg \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:16
EC_INTEGRATION_PG=1 PGPASSWORD=postgres npm test
docker stop errorcore-pg

# Option B: podman (rootless, same args)
podman run --rm -d --name errorcore-pg \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:16
EC_INTEGRATION_PG=1 PGPASSWORD=postgres npm test
podman stop errorcore-pg

# Option C: native install on macOS
brew services start postgresql@16
EC_INTEGRATION_PG=1 npm test
```

Override host/port/database/user via the standard libpq env vars:
`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`. Defaults are
`127.0.0.1:5432 postgres@postgres`.

You will also need the `pg` driver in `node_modules`:

```bash
npm install --no-save pg
```

### MySQL — `EC_INTEGRATION_MYSQL=1`

```bash
# Option A: docker
docker run --rm -d --name errorcore-mysql \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=true \
  -p 3306:3306 mysql:8
EC_INTEGRATION_MYSQL=1 npm test
docker stop errorcore-mysql

# Option B: podman
podman run --rm -d --name errorcore-mysql \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=true \
  -p 3306:3306 mysql:8
EC_INTEGRATION_MYSQL=1 npm test
podman stop errorcore-mysql

# Option C: native install
brew services start mysql
EC_INTEGRATION_MYSQL=1 npm test
```

Override via `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`,
`MYSQL_DATABASE`. Defaults: `127.0.0.1:3306 root@mysql` with empty password.

You will need the `mysql2` driver:

```bash
npm install --no-save mysql2
```

### Why these are opt-in (not in CI)

The project is pre-launch. Running pg/mysql service containers in CI
adds runtime cost and a third-party flakiness surface that we are not
prepared to triage at this stage. The recorded `dbMeta` shape is
asserted by the in-memory mongodb and ioredis suites on every CI run;
the pg/mysql2 suites cover wire-protocol details that change rarely
and are a natural fit for opt-in verification before a release.

If you want CI coverage of pg or mysql2, run the integration tests in
your fork's CI, or open a PR adding a service-container job to a
matrix that runs only on a labeled branch.

## Smoke harness

`tmp-nextjs-smoke/` builds a Next.js 14 app, starts it, fires test
requests, and asserts the captured payload includes locals + IO
timeline + a source-mapped frame. Run standalone:

```bash
cd tmp-nextjs-smoke && npm install && cd ..
npm run smoke:nextjs
```

Or wire it into the main vitest run with `EC_SMOKE_NEXTJS=1`:

```bash
cd tmp-nextjs-smoke && npm install && cd ..
EC_SMOKE_NEXTJS=1 npm test
```

The harness exits non-zero on regressions, so the wrapped vitest test
fails too.
