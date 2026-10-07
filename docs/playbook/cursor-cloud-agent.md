# Cursor Cloud Agent environment

This repository defines its Cursor Cloud Agent environment in
[`.cursor/environment.json`](../../.cursor/environment.json) and
[`.cursor/Dockerfile`](../../.cursor/Dockerfile).

Cursor resolves a repository environment before personal and team defaults.
Builds use the configuration from the default branch. When a feature branch
changes dependencies, its agent can rerun the committed install command.

## Environment contents

The dedicated Cloud Agent image:

1. Pins Node to `22.23.2`, satisfying the repository's `>=22.18.0` requirement.
2. Installs Git and CA certificates.
3. Enables Corepack.

After checking out the repository, Cursor runs the idempotent install command
from `environment.json`:

```sh
pnpm install --frozen-lockfile
```

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

The Cloud Agent image pins a complete toolchain instead of changing global
`PATH` entries at install time. This keeps setup reproducible and avoids
depending on implementation details of Cursor's default image.

## Updating the environment

- Pin a new Node patch version in `.cursor/Dockerfile` and `.node-version`.
- Keep `pnpm` pinned through `packageManager` in the root `package.json`.
- Keep the install command idempotent and free of long-running processes.
