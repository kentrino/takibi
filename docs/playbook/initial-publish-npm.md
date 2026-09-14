# First publish of a public package

Use this procedure for a package that is not yet on npm. After the first
publish, add a trusted publisher (`configure-npm-trusted-publishing.md`) and
let `.github/workflows/release.yml` publish later versions.

Do these tasks after this procedure:

- Set `RELEASE_BOT_APP_ID` (variable) and `RELEASE_BOT_PRIVATE_KEY` (secret)
- On npm, add this GitHub repository and `.github/workflows/release.yml` as a
  trusted publisher for each public package

# Published packages

| npm name | Directory |
| --- | --- |
| `takibi` | `packages/takibi` |
| `@takibi/hono-adapter` | `packages/hono-adapter` |
| `@takibi/better-auth-adapter` | `packages/better-auth-adapter` |
| `@takibi/opentelemetry` | `packages/opentelemetry` |

Internal workspace packages stay `private` and are not published. The public
SDK inlines them at pack time.

# Limits

- Do not use `npm publish`. npm does not apply `publishConfig.exports`.
  `takibi@0.0.1` was published that way: the tarball contains `dist`, but
  `exports` still point at missing `src` files.
- Publish with `vp pm publish --access public` from the package directory after
  `vp pack`.
- Do not add `NPM_TOKEN`. Do not add a token to `.npmrc`.
- Do not use `--provenance` for this first login-based publish.

# Current npm state

- `takibi@0.0.1` exists and is owned by `kentrino`. The published
  `repository.url` still points at `diaree/takibi`, and `exports` are broken.
  Leave that version in place. The next `takibi` version must come from
  `vp pm publish` (or the Release workflow) so `exports` point at `dist`.
- `@takibi/hono-adapter`, `@takibi/better-auth-adapter`, and
  `@takibi/opentelemetry` are not on npm yet.

# Step 1. (Human) Log in to npm

```sh
npm whoami --prefix /tmp
```

If `npm whoami` does not show `kentrino`, run `npm login`. Run `npm view` and
`npm whoami` outside this repository. The workspace `devEngines` field rejects
npm as the package manager.

# Step 2. (Human) Publish each missing adapter

From the repository root:

```sh
pnpm --filter takibi --filter @takibi/hono-adapter --filter @takibi/better-auth-adapter --filter @takibi/opentelemetry run build
```

For each unpublished package, inspect the tarball, then publish:

```sh
cd packages/hono-adapter
pnpm pack --dry-run
vp pm publish --access public --no-git-checks
cd ../..
```

Repeat for `packages/better-auth-adapter` and `packages/opentelemetry`.

Look at the `pnpm pack --dry-run` output and the printed `exports` map.

- The tarball must include `dist`, `package.json`, `README.md`, and `LICENSE`.
- The tarball must not include `src` or tests.
- `exports` must point at `dist/*.mjs` and `dist/*.d.mts`.
- `peerDependencies.takibi` must not contain `workspace:`.
- `repository.url` must be `git+https://github.com/kentrino/takibi.git`.

If the dry-run still shows source `exports` or `workspace:` / `catalog:`
dependency specs, do not publish.

Confirm the published package:

```sh
npm view @takibi/hono-adapter name version --prefix /tmp
```

Do not republish `takibi@0.0.1`. The next core version is the first Release
Please version after `0.0.1`.
