#!/usr/bin/env bash
#
# OpenVOD bootstrap — toolchain launcher (macOS / Linux).
#
# Node cannot install itself, and nvm is a shell function rather than a binary,
# so this shim is the one piece that has to be shell:
#   1. sanity-check OS + curl;
#   2. make node/pnpm match what this repo pins (package.json `engines` /
#      `packageManager`);
#   3. install workspace dependencies — never fatal when the wizard's own
#      dependencies are already usable;
#   4. hand the terminal to the TypeScript wizard (setup/ — clack + chalk + ora).
#
# Usage (run from anywhere inside the repo):
#   ./scripts/bootstrap.sh                     # interactive configure
#   ./scripts/bootstrap.sh --force             # regenerate existing .dev.vars
#   ./scripts/bootstrap.sh --answers file.json # headless configure
#   ./scripts/bootstrap.sh --deploy            # provision & deploy
#   ./scripts/bootstrap.sh --check [api-url]   # verify .dev.vars (+ health)
#   ./scripts/bootstrap.sh --help
#
# Environment:
#   OPENVOD_SKIP_INSTALL=1     skip `pnpm install` (dependencies must exist)
#   OPENVOD_STRICT_ENGINES=1   fail when node's major differs from engines.node
#   NO_COLOR=1                 plain, unbranded output
#
# This launcher never deploys and never runs wrangler — the wizard does, using
# each package's pinned local devDependency (`pnpm exec wrangler`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

WIZARD_ENTRY="${REPO_ROOT}/setup/src/cli.ts"
LOCAL_TSX="${REPO_ROOT}/setup/node_modules/.bin/tsx"

# ── presentation ─────────────────────────────────────────────────────────────
# Only escape when a human is watching; every consumer of this script in CI or
# a pipe gets plain text. NO_COLOR (https://no-color.org) always wins.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  C_BRAND="$(printf '\033[1;36m')"
  C_DIM="$(printf '\033[2m')"
  C_OK="$(printf '\033[32m')"
  C_WARN="$(printf '\033[33m')"
  C_FAIL="$(printf '\033[31m')"
  C_OFF="$(printf '\033[0m')"
else
  C_BRAND='' C_DIM='' C_OK='' C_WARN='' C_FAIL='' C_OFF=''
fi

ui_banner() {
  printf '\n  %sOpenVOD%s %s· bootstrap %s%s\n\n' \
    "${C_BRAND}" "${C_OFF}" "${C_DIM}" "${OPENVOD_VERSION}" "${C_OFF}"
}

ui_step() { printf '  %s→%s %s\n' "${C_BRAND}" "${C_OFF}" "$1"; }
ui_ok() { printf '  %s✔%s %s\n' "${C_OK}" "${C_OFF}" "$1"; }
ui_warn() { printf '  %s!%s %s\n' "${C_WARN}" "${C_OFF}" "$1"; }
ui_detail() { printf '      %s%s%s\n' "${C_DIM}" "$1" "${C_OFF}"; }
ui_fail() { printf '  %s✖%s %s\n' "${C_FAIL}" "${C_OFF}" "$1" >&2; }

die() {
  ui_fail "$1"
  exit 1
}

# ── repo metadata ────────────────────────────────────────────────────────────
pkg_field() {
  sed -n "s/.*\"$1\":[[:space:]]*\"\([^\"]*\)\".*/\1/p" package.json | head -n 1
}

OPENVOD_VERSION="$(pkg_field version)"
[ -n "${OPENVOD_VERSION}" ] || OPENVOD_VERSION="0.0.0"

# `22.x` / `>=22` / `^22.11` all mean "major 22" for our purposes.
NODE_ENGINE_SPEC="$(pkg_field node)"
[ -n "${NODE_ENGINE_SPEC}" ] || NODE_ENGINE_SPEC=">=22"
REQUIRED_NODE_MAJOR="$(printf '%s' "${NODE_ENGINE_SPEC}" | sed -n 's/[^0-9]*\([0-9][0-9]*\).*/\1/p')"
[ -n "${REQUIRED_NODE_MAJOR}" ] || REQUIRED_NODE_MAJOR=22

PACKAGE_MANAGER="$(pkg_field packageManager)"
PNPM_PIN="${PACKAGE_MANAGER#pnpm@}"
[ -n "${PNPM_PIN}" ] && [ "${PNPM_PIN}" != "${PACKAGE_MANAGER}" ] || PNPM_PIN="12.3.4"

LOG_FILE=""

# ── already installed? ───────────────────────────────────────────────────────
# The wizard is the only thing this launcher has to hand over, so "usable" means
# tsx plus the one runtime dependency cli.ts imports before it can render
# anything. Deliberately not a proxy for "pnpm install succeeded".
deps_ready() {
  [ -x "${LOCAL_TSX}" ] || return 1
  node -e "require.resolve('@clack/prompts', { paths: [process.argv[1]] })" \
    "${REPO_ROOT}/setup" >/dev/null 2>&1
}

# ── node ─────────────────────────────────────────────────────────────────────
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

  if [ "${major:-0}" -ge "${REQUIRED_NODE_MAJOR}" ] 2>/dev/null; then
    if [ "${major}" -ne "${REQUIRED_NODE_MAJOR}" ]; then
      # A newer major usually works and is a deliberate user choice; failing
      # here would break working installs. Say it once, loudly, and move on.
      ui_warn "node v${major} — this repo declares engines.node \"${NODE_ENGINE_SPEC}\""
      ui_detail "switch to it with:  nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}"
      ui_detail "or re-run with OPENVOD_STRICT_ENGINES=1 to make this fatal"
      if [ "${OPENVOD_STRICT_ENGINES:-0}" = "1" ]; then
        die "OPENVOD_STRICT_ENGINES=1 and node ${major} != ${REQUIRED_NODE_MAJOR}"
      fi
    else
      ui_ok "node $(node -v)  ${C_DIM}(engines ${NODE_ENGINE_SPEC})${C_OFF}"
    fi
    return 0
  fi

  ui_warn "node ${major:-missing} does not satisfy \"${NODE_ENGINE_SPEC}\" — installing via nvm"
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

  nvm install "${REQUIRED_NODE_MAJOR}" >/dev/null || nvm install "${REQUIRED_NODE_MAJOR}"
  nvm alias default "${REQUIRED_NODE_MAJOR}" >/dev/null 2>&1 || true
  nvm use default >/dev/null 2>&1 || nvm use "${REQUIRED_NODE_MAJOR}" >/dev/null 2>&1 || true
  hash -r

  major="$(node_major)"
  if [ "${major:-0}" -lt "${REQUIRED_NODE_MAJOR}" ] 2>/dev/null; then
    die "node ${major} is still on PATH — restart your shell and re-run"
  fi
  ui_ok "node $(node -v)  ${C_DIM}(installed via nvm)${C_OFF}"
}

# ── pnpm ─────────────────────────────────────────────────────────────────────
pnpm_version() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm -v 2>/dev/null | head -n 1
  fi
}

# The lockfile records the exact pnpm that produced it (and pnpm-workspace.yaml
# is only fully understood by a matching CLI), so "some pnpm >= 10" is not good
# enough: a different major can silently rewrite a tracked file.
activate_pinned_pnpm() {
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    if corepack prepare "pnpm@${PNPM_PIN}" --activate >/dev/null 2>&1; then
      return 0
    fi
  fi
  npm install -g "pnpm@${PNPM_PIN}" >/dev/null 2>&1
}

ensure_pnpm() {
  local found
  found="$(pnpm_version)"

  if [ -z "${found}" ]; then
    ui_warn "pnpm is not installed — installing pnpm@${PNPM_PIN}"
    activate_pinned_pnpm || die "could not install pnpm — run: npm install -g pnpm@${PNPM_PIN}"
    hash -r
    found="$(pnpm_version)"
  fi

  if [ "${found}" = "${PNPM_PIN}" ]; then
    ui_ok "pnpm ${found}  ${C_DIM}(pinned by package.json)${C_OFF}"
    return 0
  fi

  ui_warn "pnpm ${found:-unknown} — this repo pins ${PNPM_PIN}"
  if activate_pinned_pnpm; then
    hash -r
    found="$(pnpm_version)"
    if [ "${found}" = "${PNPM_PIN}" ]; then
      ui_ok "pnpm ${found}"
      return 0
    fi
  fi
  ui_warn "continuing with pnpm ${found:-unknown} — it may rewrite pnpm-lock.yaml"
  ui_detail "fix with:  npm install -g pnpm@${PNPM_PIN}"
}

# ── dependencies ─────────────────────────────────────────────────────────────
# Runs pnpm with output both streamed (so a long install is not a black box)
# and captured (so a failure can be diagnosed instead of guessed at).
# Always call this in an `if` condition.
run_pnpm_install() {
  local extra="${1:-}"
  local rc=0
  if [ -t 1 ]; then
    # shellcheck disable=SC2086
    pnpm install ${extra} 2>&1 | tee "${LOG_FILE}"
  else
    # shellcheck disable=SC2086
    pnpm install ${extra} --reporter=append-only 2>&1 | tee "${LOG_FILE}"
  fi
  rc="${PIPESTATUS[0]}"
  return "${rc}"
}

install_deps() {
  if [ "${OPENVOD_SKIP_INSTALL:-0}" = "1" ]; then
    ui_warn "OPENVOD_SKIP_INSTALL=1 — skipping pnpm install"
    return 0
  fi

  ui_step "installing workspace dependencies"
  LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/openvod-bootstrap.XXXXXX")"

  if run_pnpm_install ""; then
    ui_ok "dependencies ready"
    rm -f "${LOG_FILE}"
    LOG_FILE=""
    return 0
  fi

  # pnpm freezes the lockfile automatically when CI is set. That is the single
  # most common "it worked yesterday" failure, and the fix is unambiguous.
  if grep -qE 'ERR_PNPM_(OUTDATED_LOCKFILE|LOCKFILE_CONFIG_MISMATCH|FROZEN_LOCKFILE)' "${LOG_FILE}" 2>/dev/null; then
    ui_warn "the lockfile is out of date with the manifests — retrying with --no-frozen-lockfile"
    if run_pnpm_install "--no-frozen-lockfile"; then
      ui_ok "dependencies ready  ${C_DIM}(pnpm-lock.yaml updated)${C_OFF}"
      rm -f "${LOG_FILE}"
      LOG_FILE=""
      return 0
    fi
  fi

  ui_fail "pnpm install failed — last 20 lines:"
  tail -n 20 "${LOG_FILE}" 2>/dev/null || true
  ui_detail "full log: ${LOG_FILE}"

  # A dependency-install hiccup is not a reason to block a wizard that can
  # already run: that was the old behaviour, and it made a working checkout
  # look broken whenever the registry was slow or offline.
  if deps_ready; then
    ui_warn "the wizard's dependencies are already present — continuing"
    ui_detail "fix the install when convenient:  pnpm install"
    return 0
  fi

  ui_fail "and the wizard's dependencies are missing, so there is nothing to run"
  printf '\n' >&2
  printf '  most likely:\n' >&2
  printf '    · pnpm %s is required (this repo pins it in package.json)\n' "${PNPM_PIN}" >&2
  printf '    · node %s is required (nvm install %s && nvm use %s)\n' \
    "${REQUIRED_NODE_MAJOR}" "${REQUIRED_NODE_MAJOR}" "${REQUIRED_NODE_MAJOR}" >&2
  printf '    · the npm registry is unreachable (offline, proxy, or a private mirror)\n' >&2
  printf '  retry:  pnpm install\n' >&2
  exit 1
}

# ── help ─────────────────────────────────────────────────────────────────────
# The wizard owns the full help (and its schema docs). This fallback exists so
# `--help` still answers on a fresh clone, before anything is installed.
print_launcher_help() {
  cat <<EOF
OpenVOD bootstrap — BYOK environment wizard

Usage (run from anywhere inside the repo):
  ./scripts/bootstrap.sh                        interactive configure
                                                (writes server/.dev.vars + delivery/.dev.vars)
  ./scripts/bootstrap.sh --force                regenerate; keys the wizard does not
                                                manage are preserved
  ./scripts/bootstrap.sh --answers <file.json>  headless configure (no terminal needed)
  ./scripts/bootstrap.sh --deploy               provision & deploy (Cloudflare + Modal)
  ./scripts/bootstrap.sh --check [api-url]      verify .dev.vars without printing secrets
  ./scripts/bootstrap.sh --help

Prefill flags (interactive only):
  --runtime workers|node   --db neon|local|existing
  --queue direct|qstash    --ratelimit memory|upstash

Environment:
  OPENVOD_SKIP_INSTALL=1     skip \`pnpm install\`
  OPENVOD_STRICT_ENGINES=1   fail when node's major differs from engines.node
  NO_COLOR=1                 plain output

Dependencies are not installed yet. Run ./scripts/bootstrap.sh to install them
and start the wizard.
EOF
}

# ── main ─────────────────────────────────────────────────────────────────────
git_missing() { ! command -v git >/dev/null 2>&1; }

main() {
  local want_help=0
  case "${1:-}" in
    -h | --help) want_help=1 ;;
  esac

  case "$(uname -s 2>/dev/null || true)" in
    Darwin | Linux) ;;
    MINGW* | MSYS* | CYGWIN*)
      die "Windows is not supported by this launcher yet — use WSL (wsl --install), then run ./scripts/bootstrap.sh inside it."
      ;;
    *)
      die "unsupported operating system: $(uname -s 2>/dev/null || echo unknown)"
      ;;
  esac

  # Help must never install anything: answer it from the wizard when the wizard
  # is already runnable, and from the fallback text on a fresh clone.
  if [ "${want_help}" = "1" ]; then
    if [ -x "${LOCAL_TSX}" ]; then
      exec "${LOCAL_TSX}" "${WIZARD_ENTRY}" --help
    fi
    print_launcher_help
    exit 0
  fi

  ui_banner

  command -v curl >/dev/null 2>&1 || die "curl is required (brew install curl / apt-get install curl)."
  if git_missing; then
    ui_warn "git not found — install it to clone/update this repository"
  fi

  ensure_node
  ensure_pnpm
  install_deps

  if ! deps_ready; then
    ui_fail "the setup wizard's dependencies are missing"
    ui_detail "install them with:  pnpm install"
    exit 1
  fi

  # Hand over by exec'ing the project's own tsx directly. Going through
  # `pnpm --filter … exec` wraps every non-zero exit in pnpm's own
  # ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL noise, which buries the wizard's message.
  printf '\n'
  if [ -x "${LOCAL_TSX}" ]; then
    exec "${LOCAL_TSX}" "${WIZARD_ENTRY}" "$@"
  fi
  exec pnpm --filter openvod-setup exec tsx "${WIZARD_ENTRY}" "$@"
}

trap 'printf "\n"; ui_fail "interrupted"; exit 130' INT TERM
main "$@"
