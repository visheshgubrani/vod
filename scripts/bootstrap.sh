#!/usr/bin/env bash
#
# OpenVOD bootstrap — thin POSIX launcher (macOS / Linux).
#
# Node cannot install itself and nvm is a shell function, so this shim:
#   1. OS + curl sanity checks (Windows: use WSL; PowerShell launcher planned).
#   2. Ensures Node (>=22) via nvm when missing.
#   3. Ensures pnpm, pinned to the root package.json `packageManager` field.
#   4. Runs `pnpm install` (skip with OPENVOD_SKIP_INSTALL=1).
#   5. Hands off to the TypeScript wizard (setup/ — clack + chalk + ora).
#
# Usage (run from anywhere inside the repo):
#   ./scripts/bootstrap.sh                     # interactive configure
#   ./scripts/bootstrap.sh --force             # regenerate existing .dev.vars
#   ./scripts/bootstrap.sh --answers file.json # headless configure
#   ./scripts/bootstrap.sh --deploy            # provision & deploy
#   ./scripts/bootstrap.sh --check [api-url]  # verify .dev.vars (+ health)
#   ./scripts/bootstrap.sh --help
#
# This launcher never deploys and never runs wrangler — the wizard does,
# using each package's pinned local devDependency (`pnpm exec wrangler`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

MIN_NODE_MAJOR=22
PACKAGE_MANAGER="$(sed -n 's/.*"packageManager":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)"
PNPM_PIN="${PACKAGE_MANAGER#pnpm@}"
[ -n "${PNPM_PIN}" ] || PNPM_PIN="12.3.4"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

OS="$(uname -s 2>/dev/null || true)"
case "${OS}" in
  Darwin | Linux) ;;
  MINGW* | MSYS* | CYGWIN*)
    die "Windows is not supported by this launcher yet — use WSL, or the upcoming PowerShell bootstrap (scripts/bootstrap.ps1, planned)."
    ;;
  *) die "unsupported operating system: ${OS}" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required (brew install curl / apt-get install curl)."
command -v git >/dev/null 2>&1 || printf 'warning: git not found — keep it installed for updates.\n' >&2

node_major() {
  if command -v node >/dev/null 2>&1; then
    node -v 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p'
  else
    printf '0'
  fi
}

ensure_node() {
  local major
  major="$(node_major)"
  if [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ] 2>/dev/null; then
    return 0
  fi

  printf 'node %s is too old (needs >= %s) — installing via nvm\n' "${major:-missing}" "${MIN_NODE_MAJOR}"
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  export NVM_DIR="${nvm_dir}"

  if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
    local nvm_tag
    nvm_tag="$(curl -fsSL --max-time 60 https://api.github.com/repos/nvm-sh/nvm/releases/latest \
      | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "${nvm_tag}" ] || nvm_tag="v0.40.1"
    curl -fsSL --max-time 180 "https://raw.githubusercontent.com/nvm-sh/nvm/${nvm_tag}/install.sh" | bash \
      || die "nvm install failed — see https://github.com/nvm-sh/nvm"
  fi

  # shellcheck disable=SC1090
  . "${NVM_DIR}/nvm.sh"

  nvm install "${MIN_NODE_MAJOR}" >/dev/null || nvm install "${MIN_NODE_MAJOR}"
  nvm alias default "${MIN_NODE_MAJOR}" >/dev/null 2>&1 || true
  nvm use default >/dev/null 2>&1 || nvm use "${MIN_NODE_MAJOR}" >/dev/null 2>&1 || true
  hash -r

  major="$(node_major)"
  if [ "${major:-0}" -lt "${MIN_NODE_MAJOR}" ] 2>/dev/null; then
    die "node ${major} is still on PATH — restart your shell and re-run"
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    local installed major
    installed="$(pnpm -v 2>/dev/null | head -n 1)"
    major="${installed%%.*}"
    if [ -n "${major}" ] && [ "${major}" -lt 10 ]; then
      npm install -g "pnpm@${PNPM_PIN}" >/dev/null 2>&1 \
        || die "could not upgrade pnpm — run: npm install -g pnpm@${PNPM_PIN}"
    else
      return 0
    fi
  else
    if command -v corepack >/dev/null 2>&1; then
      corepack enable >/dev/null 2>&1 || true
    fi
    if command -v pnpm >/dev/null 2>&1; then
      return 0
    fi
    npm install -g "pnpm@${PNPM_PIN}" >/dev/null \
      || die "could not install pnpm — run: npm install -g pnpm@${PNPM_PIN}"
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm is still not on PATH — restart your shell and re-run"
}

ensure_node
ensure_pnpm

if [ "${OPENVOD_SKIP_INSTALL:-0}" != "1" ]; then
  pnpm install || die "pnpm install failed — fix the errors above and re-run"
fi

# shellcheck disable=SC2086
exec pnpm --filter openvod-setup exec tsx "${REPO_ROOT}/setup/src/cli.ts" "$@"
