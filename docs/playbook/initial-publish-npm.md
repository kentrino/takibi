# First publish of a public package

Use this procedure for a package that is not yet on npm. After the first
publish, add a trusted publisher (`configure-npm-trusted-publishing.md`) and
let `.github/workflows/release.yml` publish later versions.

Do these tasks after this procedure:

- Set `RELEASE_BOT_APP_ID` (variable) and `RELEASE_BOT_PRIVATE_KEY` (secret)
- On npm, add this GitHub repository and `.github/workflows/release.yml` as a
  trusted publisher for each public package

# Published packages

| npm name                      | Directory                      |
| ----------------------------- | ------------------------------ |
| `takibi`                      | `packages/takibi`              |
| `@takibi/hono-adapter`        | `packages/hono-adapter`        |
| `@takibi/better-auth-adapter` | `packages/better-auth-adapter` |
| `@takibi/opentelemetry`       | `packages/opentelemetry`       |
| `@takibi/cloudflare-tracing`  | `packages/cloudflare-tracing`  |

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
  Leave that version in place. Source `packages/takibi` is `0.0.1` so
  Release Please and packed adapter peers line up with npm. The next core
  version must come from `vp pm publish` or the Release workflow so `exports`
  point at `dist`.
- `@takibi/hono-adapter@0.0.0`, `@takibi/better-auth-adapter@0.0.0`, and
  `@takibi/opentelemetry@0.0.0` are on npm with `kentrino/takibi` repository
  metadata. Their published `peerDependencies.takibi` is `^0.0.0`, which does
  not match `takibi@0.0.1`. Source adapters stay at `0.0.0` so Release Please
  treats them as unpublished and uses `initial-version` `0.1.0`. The next
  adapter release must pack after core is `0.1.0` so the peer rewrites to
  `^0.1.0`. Do not let adapters jump to `1.0.0`.

Do not republish `takibi@0.0.1`. Do not use this procedure for packages that
are already on npm.

# Step 1. (Human) Log in to npm

```sh
npm whoami --prefix /tmp
```

If `npm whoami` does not show `kentrino`, run `npm login`. Run `npm view` and
`npm whoami` outside this repository. The workspace `devEngines` field rejects
npm as the package manager.

# Step 2. (Human) Publish a package that is not on npm yet

From the repository root, build the new package, inspect the tarball, then
publish from that package directory:

```sh
pnpm --filter <npm-name> run build
cd <package-directory>
pnpm pack --dry-run
vp pm publish --access public --no-git-checks
cd ../..
```

Look at the `pnpm pack --dry-run` output and the printed `exports` map.

- The tarball must include `dist`, `package.json`, `README.md`, and `LICENSE`.
- The tarball must not include `src` or tests.
- `exports` must point at `dist/*.mjs` and `dist/*.d.mts`.
- Dependency specs must not contain `workspace:` or `catalog:`.
- Adapter `peerDependencies.takibi` must be `^` plus the current
  `packages/takibi` version, not `workspace:`.
- `repository.url` must be `git+https://github.com/kentrino/takibi.git`.

If the dry-run still shows source `exports` or `workspace:` / `catalog:`
dependency specs, do not publish.

Confirm the published package:

```sh
npm view <npm-name> name version --prefix /tmp
```
