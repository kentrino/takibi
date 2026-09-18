# Cursor Cloud Agent environment

This repository ships a committed Cursor Cloud Agent environment so background
agents can install, type-check, test, and build Takibi the same way CI does.
The configuration lives in [`.cursor/environment.json`](../../.cursor/environment.json)
and [`.cursor/install.sh`](../../.cursor/install.sh).

Because the config is committed, it is versioned with the code, follows
branches and pull requests, and takes precedence over any dashboard-managed
environment. There is nothing to click to "save"; updating these files updates
the environment.

## What the environment does

On checkout the Cloud Agent runs `bash .cursor/install.sh`, which:

1. Selects a modern **Node 22** (`nvm install 22` + `nvm alias default 22`).
2. Enables Corepack so `pnpm` matches `packageManager` in `package.json`.
3. Symlinks `node`/`pnpm`/`npm`/`npx`/`corepack` into `/usr/local/cargo/bin`.
4. Runs `pnpm install --frozen-lockfile`.

No long-running service is needed — Takibi is a library monorepo, so there is
no `start` command. Verify a working environment with the same commands as CI:

```sh
pnpm ready      # vp check + recursive test + recursive build
pnpm test:e2e   # packs the public packages and exercises a consumer
```

## Why Node 22.18+ is required (and why it is not automatic)

Takibi's storage tests use `node:sqlite`'s `StatementSync.columns()`, which was
added in **Node 22.18.0**. On older Node this fails with:

```
TypeError: statement.columns is not a function
```

The subtle part: the Cloud Agent runtime injects its own Node binary onto
`PATH` _ahead_ of the base image's Node. On the image we build from, that
runtime Node is older than 22.18.0. Simply installing a newer Node via `nvm`
is **not** enough, because the runtime's Node still wins name resolution —
including in the non-login, non-interactive shells the agent uses to run
commands, which never source `~/.bashrc` or `~/.profile`.

`.cursor/install.sh` fixes this deterministically by placing symlinks to the
Node 22 toolchain in `/usr/local/cargo/bin`. On the default Cursor base image
that directory is world-writable and sits _before_ the runtime's Node directory
on `PATH` for every shell type, so `node` and `pnpm` resolve to Node 22
everywhere without depending on shell startup files.

## The reference Dockerfile

The repository root [`Dockerfile`](../../Dockerfile) is a **reference**, not the
image Cloud Agents boot from. Its job is to document the exact toolchain in one
obvious place so humans (and agents) don't have to rediscover it, and to let
anyone build and test the workspace in a clean, reproducible container. It is
intentionally not wired into `.cursor/environment.json`.

It is multi-stage:

- `test` — installs dependencies and runs the full CI pipeline (`pnpm ready` +
  `pnpm test:e2e`). `docker build --target test .` fails if any check fails.
- `app` — the built, publishable SDK on a clean Node runtime. Because the built
  `takibi` package inlines its workspace dependencies (only `node:sqlite`
  remains), it runs with no `node_modules`; the default command
  ([`docker/app-smoke.mjs`](../../docker/app-smoke.mjs)) performs a real
  create/read round-trip through the SQLite test backend.

```sh
docker build --target test -t takibi-test .
docker build --target app  -t takibi-app  .
docker run --rm takibi-app
```

Note the Dockerfile installs `git` and pins Node via a `node:22.x` base image,
so it does not depend on the Cloud Agent runtime or the `/usr/local/cargo/bin`
trick above — it stands on its own.

## Why not build the Cloud Agent from the Dockerfile?

A custom image for the Cloud Agent does **not** remove the Node-shadowing issue:
the runtime still injects its own Node ahead of whatever the image provides, so
you would need the same "put our Node ahead on PATH" trick anyway. A custom
image also gives up conveniences preinstalled on the default image (nvm, the
Rust toolchain, a browser for computer-use testing, the VNC desktop), and the
`/usr/local/cargo/bin` directory we rely on may not exist there. So the Cloud
Agent keeps using the default image plus `install.sh`, and the Dockerfile stays
a reference for local/CI use.

## Updating the environment

- Change install behavior in `.cursor/install.sh`; keep it idempotent.
- Keep `pnpm` pinned via `packageManager` in `package.json`; Corepack honors it.
- If the base image ever ships Node ≥ 22.18.0 by default as the resolved
  `node`, the `/usr/local/cargo/bin` symlinks become redundant but remain
  harmless.
