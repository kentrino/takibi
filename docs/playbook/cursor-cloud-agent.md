# Cursor Cloud Agent environment

This repository defines its Cursor Cloud Agent environment in
[`.cursor/environment.json`](../../.cursor/environment.json).

Cursor resolves a repository environment before personal and team defaults.

## Environment contents

Cloud Agents currently start from Cursor's default image when no finished
environment Build is available. That default image injects an older Node onto
`PATH` ahead of any image-provided Node, so pinning Node only in a Dockerfile
is not enough for agent shells.

The committed install script [`.cursor/install.sh`](../../.cursor/install.sh):

1. Installs Node 22 via `nvm` (already present on the default image).
2. Exposes `node` / `pnpm` through `/usr/local/cargo/bin`, the writable `PATH`
   slot that precedes the runtime-injected Node.
3. Runs `pnpm install --frozen-lockfile`.

`.cursor/environment.json` runs that script:

```sh
bash .cursor/install.sh
```

[`.cursor/Dockerfile`](../../.cursor/Dockerfile) remains available for a future
environment Build that pins `node:22.23.2-bookworm-slim`. Do not add
`build.dockerfile` to `environment.json` until Builds are enabled and a
finished Build exists; with `build.dockerfile` and `no_finished_builds`, Cursor
falls back to the default image and skips the install script entirely.

No startup command is needed because Takibi is a library monorepo. Verify an
agent environment with the same commands used locally:

```sh
pnpm ready
pnpm test:e2e
```

## Why Node 22.18+ is required

Takibi's storage tests use `node:sqlite`'s `StatementSync.columns()`, which was
added in Node 22.18.0. Older versions fail with:

```text
TypeError: statement.columns is not a function
```

## Why there are two Dockerfiles

The Dockerfiles have different responsibilities:

- [`.cursor/Dockerfile`](../../.cursor/Dockerfile) is the candidate Cloud Agent
  base image for environment Builds. It installs tools only; Cursor manages the
  checkout and runs the install command.
- [`Dockerfile`](../../Dockerfile) is the repository's standalone verification
  image. It copies the checkout and provides `test` and `scenario` targets.

The standalone targets are:

- `test` runs `pnpm ready` and the packed-package E2E suite.
- `scenario` runs the packed issue-tracker `node:test` bundle on a clean Node
  runtime.

```sh
docker build --target test -t takibi-test .
docker build --target scenario -t takibi-scenario .
docker run --rm takibi-scenario
```

## Updating the environment

- Keep the `cargo/bin` PATH override in `.cursor/install.sh` until a finished
  environment Build is proven to expose Node `>=22.18.0` as the default `node`
  in agent shells.
- Keep `pnpm` pinned through `packageManager` in the root `package.json`.
- Keep the install command idempotent and free of long-running processes.
- When enabling Builds, validate a draft Build, confirm `node -v` on a fresh
  agent, then optionally switch `environment.json` to `build.dockerfile` plus a
  short `install` such as `pnpm install --frozen-lockfile`.
