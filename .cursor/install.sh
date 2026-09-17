#!/usr/bin/env bash
# Cursor Cloud Agent bootstrap for the Takibi monorepo.
#
# Takibi's tests exercise node:sqlite's StatementSync.columns(), which only
# exists on Node >= 22.18.0. The Cloud Agent runtime injects its own, older
# Node onto PATH ahead of the base image's Node, so having a newer Node merely
# installed is not enough: it stays shadowed. We install a modern Node 22 via
# nvm (preinstalled on the default image) and expose it through
# /usr/local/cargo/bin, which precedes the runtime's Node directory on PATH for
# every kind of shell (login, non-login, interactive, non-interactive).
#
# See docs/playbook/cursor-cloud-agent.md for the full rationale.
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "error: nvm not found at $NVM_DIR (expected on the default Cursor base image)" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"

# Install and default to the latest Node 22 (>= 22.18.0). Idempotent.
nvm install 22 >/dev/null
nvm alias default 22 >/dev/null

node_dir="$(dirname "$(nvm which default)")"

# Provide pnpm/yarn shims for the selected Node before we symlink them.
corepack enable >/dev/null 2>&1 || true

# Expose the modern toolchain ahead of the runtime-injected Node. This is what
# makes `node`/`pnpm` resolve to Node 22 in every shell, without relying on
# shell rc files being sourced.
override_dir=/usr/local/cargo/bin
if [ -d "$override_dir" ] && [ -w "$override_dir" ]; then
  for bin in node npm npx corepack pnpm pnpx yarn; do
    [ -e "$node_dir/$bin" ] && ln -sf "$node_dir/$bin" "$override_dir/$bin"
  done
else
  echo "warning: $override_dir is not writable; relying on nvm PATH only" >&2
fi

pnpm install --frozen-lockfile
