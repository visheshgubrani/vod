#!/usr/bin/env bash
#
# OpenVOD bootstrap — Phase 0 POSIX launcher (macOS / Linux).
#
#   1. OS + curl sanity checks (Windows needs the planned PowerShell
#      launcher; for now use WSL).
#   2. Ensures Node (>=22, the repo's engines line) — installing nvm when it
#      is missing, then Node 22 LTS through nvm.
#   3. Ensures pnpm — pinned to the root package.json `packageManager`
#      version, via corepack when available, else npm -g.
#   4. Runs `pnpm install` (idempotent) so the project-pinned wrangler and
#      the wizard's own package are present. Set OPENVOD_SKIP_INSTALL=1 to
#      skip this step.
#   5. Hands off to the interactive TypeScript wizard (setup/ — clack TUI):
#      architecture choices (runtime / postgres / queue / rate limiting),
#      .dev.vars generation, and an OPT-IN Cloudflare + Modal deploy phase.
#
# Usage (run from anywhere inside the repo):
#   ./scripts/bootstrap.sh                     # interactive configure
#   ./scripts/bootstrap.sh --force             # regenerate existing .dev.vars
#   ./scripts/bootstrap.sh --answers file.json # headless configure
#   ./scripts/bootstrap.sh --deploy            # provision & deploy
#   ./scripts/bootstrap.sh --check [api-url]   # verify .dev.vars (+ health)
#   ./scripts/bootstrap.sh --help
#
# Note: this launcher never deploys anything by itself and never runs
# wrangler — the wizard does, using each package's pinned local devDependency
# (`pnpm exec wrangler`), never a global or `npx`-fetched wrangler.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

MIN_NODE_MAJOR=22

# pnpm version pinned in the root package.json ("packageManager" field).
PACKAGE_MANAGER="$(sed -n 's/.*"packageManager":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)"
PNPM_PIN="${PACKAGE_MANAGER#pnpm@}"
[ -n "${PNPM_PIN}" ] || PNPM_PIN="10.12.4"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_BOLD=$'\033[1m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_YEL=$'\033[33m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""; C_CYAN=""; C_GREEN=""; C_RED=""; C_YEL=""; C_DIM=""; C_RESET=""
fi

ok()   { printf '  %s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$1"; }
info() { printf '  %s→%s %s\n' "${C_DIM}" "${C_RESET}" "$1"; }
warn() { printf '  %s!%s %s\n' "${C_YEL}" "${C_RESET}" "$1"; }
die()  { printf '%s✗%s %s\n' "${C_RED}" "${C_RESET}" "$1" >&2; exit 1; }

step() { printf '\n%s▸%s %s\n' "${C_BOLD}${C_CYAN}" "${C_RESET}" "$1"; }

# ── 1. OS / prerequisites ───────────────────────────────────────────────────

OS="$(uname -s 2>/dev/null || true)"
case "${OS}" in
  Darwin | Linux) ;;
  MINGW* | MSYS* | CYGWIN*)
    die "Windows is not supported by this launcher yet — use WSL, or the upcoming PowerShell bootstrap (scripts/bootstrap.ps1, planned)."
    ;;
  *) die "unsupported operating system: ${OS}" ;;
esac

step "OpenVOD bootstrap — environment check"
command -v curl >/dev/null 2>&1 || die "curl is required (brew install curl / apt-get install curl)."
command -v git >/dev/null 2>&1 || warn "git not found — you probably cloned via another tool; keep it installed for updates."

node_major() {
  if command -v node >/dev/null 2>&1; then
    node -v 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p'
  else
    printf '0'
  fi
}

# ── 2. Node (>=22) — via nvm, installing nvm when missing ───────────────────

ensure_node() {
  local major
  major="$(node_major)"
  if [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ] 2>/dev/null; then
    ok "node ${major} found"
    if [ "${major}" != "${MIN_NODE_MAJOR}" ]; then
      warn "repo engines say ${MIN_NODE_MAJOR}.x; node ${major} usually works — pnpm may print an engines warning"
    fi
    return 0
  fi

  warn "node ${major:-missing} is too old for this repo (needs >= ${MIN_NODE_MAJOR})"
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  export NVM_DIR="${nvm_dir}"

  if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
    info "nvm not found — installing it into ${NVM_DIR} …"
    local nvm_tag
    nvm_tag="$(curl -fsSL --max-time 60 https://api.github.com/repos/nvm-sh/nvm/releases/latest \
      | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "${nvm_tag}" ] || nvm_tag="v0.40.1"
    curl -fsSL --max-time 180 "https://raw.githubusercontent.com/nvm-sh/nvm/${nvm_tag}/install.sh" | bash \
      || die "nvm install failed — see https://github.com/nvm-sh/nvm (install nvm, then re-run)"
  fi

  # nvm is a shell function — source it (safe in non-interactive shells too).
  # shellcheck disable=SC1090
  . "${NVM_DIR}/nvm.sh"

  info "installing node ${MIN_NODE_MAJOR} (LTS) via nvm…"
  nvm install "${MIN_NODE_MAJOR}" >/dev/null || nvm install "${MIN_NODE_MAJOR}"
  nvm alias default "${MIN_NODE_MAJOR}" >/dev/null 2>&1 || true
  nvm use default >/dev/null 2>&1 || nvm use "${MIN_NODE_MAJOR}" >/dev/null 2>&1 || true
  hash -r

  major="$(node_major)"
  if [ "${major:-0}" -lt "${MIN_NODE_MAJOR}" ] 2>/dev/null; then
    die "node ${major} is still on PATH — restart your shell (nvm alias default) and re-run, or open a new terminal"
  fi
  ok "node ${major} ready"
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    local installed major
    installed="$(pnpm -v 2>/dev/null | head -n 1)"
    major="${installed%%.*}"
    if [ -n "${major}" ] && [ "${major}" -lt 10 ]; then
      warn "pnpm ${installed} is older than 10 — upgrading to pnpm@${PNPM_PIN}"
      npm install -g "pnpm@${PNPM_PIN}" >/dev/null 2>&1 \
        || die "could not upgrade pnpm — run: npm install -g pnpm@${PNPM_PIN}"
    else
      ok "pnpm ${installed} found"
      return 0
    fi
  else
    if command -v corepack >/dev/null 2>&1; then
      info "enabling corepack (installs the pnpm shim for this node)…"
      corepack enable >/dev/null 2>&1 || true
    fi
    if command -v pnpm >/dev/null 2>&1; then
      ok "pnpm shim enabled via corepack"
      return 0
    fi
    info "installing pnpm@${PNPM_PIN} globally (npm install -g)…"
    npm install -g "pnpm@${PNPM_PIN}" >/dev/null \
      || die "could not install pnpm — run: npm install -g pnpm@${PNPM_PIN} (sudo may be needed for a system node)"
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm is still not on PATH — restart your shell and re-run"
  ok "pnpm $(pnpm -v 2>/dev/null | head -n 1) ready"
}

ensure_node
ensure_pnpm

# ── 3. Workspace install ────────────────────────────────────────────────────

if [ "${OPENVOD_SKIP_INSTALL:-0}" = "1" ]; then
  info "skipping pnpm install (OPENVOD_SKIP_INSTALL=1)"
else
  info "pnpm install (idempotent — also picks up new deps after git pulls)…"
  pnpm install || die "pnpm install failed — fix the errors above and re-run"
fi

# ── 4. Interactive wizard (TypeScript, run by the node we just ensured) ─────

step "OpenVOD setup wizard"
# shellcheck disable=SC2086
exec pnpm --filter openvod-setup exec tsx "${REPO_ROOT}/setup/src/cli.ts" "$@"
