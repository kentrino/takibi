# Reference multi-stage build for the Takibi monorepo.
#
# IMPORTANT: Cursor Cloud Agents do NOT build from this file. They use the
# default base image plus .cursor/install.sh (see
# docs/playbook/cursor-cloud-agent.md). This Dockerfile is a reference that
# documents the exact toolchain and lets anyone build and test the workspace in
# a clean, reproducible container.
#
# Node >= 22.18.0 is mandatory: Takibi's storage layer uses node:sqlite's
# StatementSync.columns(), which does not exist on older Node.
#
# Targets:
#   test  - runs the full CI pipeline (type-check, tests, build, packed e2e)
#   app   - the built SDK on a clean runtime, with a real round-trip smoke test
#
# Examples:
#   docker build --target test -t takibi-test .   # fails if any check fails
#   docker build --target app  -t takibi-app  .
#   docker run --rm takibi-app

# Pin a Node 22 that satisfies the >= 22.18.0 requirement.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim

# --- Shared base: Node + pnpm via Corepack --------------------------------
FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV CI=1
WORKDIR /app
# git is required by the repo's prepare script (`vp config`); ca-certificates
# for HTTPS during dependency install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# --- Dependencies: install from the frozen lockfile -----------------------
FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

# --- Test image: the same checks CI runs ----------------------------------
FROM deps AS test
RUN pnpm ready
RUN pnpm test:e2e

# --- Build: compile dist/ for every workspace package ---------------------
FROM deps AS build
RUN pnpm -r build

# --- App image: the built SDK on a clean Node runtime ---------------------
# Takibi is a library, so the "app" image is the publishable SDK artifact. The
# built takibi package is self-contained (workspace packages are inlined; the
# only runtime import is the built-in node:sqlite), so it runs with no
# node_modules. The default command is a real create/read round-trip.
FROM ${NODE_IMAGE} AS app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/packages/takibi/dist ./takibi/dist
COPY --from=build /app/packages/takibi/package.json ./takibi/package.json
COPY docker/app-smoke.mjs ./app-smoke.mjs
CMD ["node", "app-smoke.mjs"]
