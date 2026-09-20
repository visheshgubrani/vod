#!/usr/bin/env bash
#
# ClipMux host installer — provision this machine (or a VPS) with Docker Compose.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/visheshgubrani/vod/main/scripts/install.sh | bash
#   ./scripts/install.sh                  # from a checkout
#   ./scripts/install.sh --help
#   ./scripts/install.sh --doctor
#
# Pin both the downloaded script and CLIPMUX_VERSION to the same ref.
# CLIPMUX_VERSION must be in the piped bash environment (curl never forwards it):
#   curl -fsSL \
#     https://raw.githubusercontent.com/visheshgubrani/vod/<git-sha>/scripts/install.sh \
#     | CLIPMUX_VERSION=<git-sha> bash
#   # or: export CLIPMUX_VERSION=<git-sha> first, then curl … | bash
#
# Environment:
#   CLIPMUX_DIR        install prefix (default: /opt/clipmux as root, ~/clipmux otherwise;
#                      in-repo runs use that checkout unless this is set)
#   CLIPMUX_VERSION    git ref to clone for a fresh remote install (default: main)
#   CLIPMUX_NO_SUDO=1  never escalate; print the command instead
#   CLIPMUX_SKIP_INSTALL=1   skip toolchain installs (wizard dependencies must exist)
#   NO_COLOR=1         plain output
#
# This script never uses Docker's convenience installer. On supported
# Ubuntu/Debian releases it adds Docker's apt repository; elsewhere Docker
# Engine must already work. An existing Docker installation is never upgraded.

set -euo pipefail

CLIPMUX_REPO="${CLIPMUX_REPO:-https://github.com/visheshgubrani/vod.git}"
CLIPMUX_FETCH_BASE="${CLIPMUX_FETCH_BASE:-https://raw.githubusercontent.com/visheshgubrani/vod}"
CLIPMUX_TTY="${CLIPMUX_TTY:-/dev/tty}"
STATE_NAME=".clipmux-install"

# ── presentation ─────────────────────────────────────────────────────────────
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
  printf '\n  %sClipMux%s %s· host install%s\n\n' \
    "${C_BRAND}" "${C_OFF}" "${C_DIM}" "${C_OFF}"
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

print_help() {
  cat <<EOF
ClipMux host installer — Docker Compose on this machine or a VPS

Usage:
  curl -fsSL https://raw.githubusercontent.com/visheshgubrani/vod/main/scripts/install.sh | bash
  ./scripts/install.sh                 from a checkout (uses that tree unless CLIPMUX_DIR is set)
  ./scripts/install.sh --doctor        report what this machine has; installs and writes nothing
  ./scripts/install.sh --help

Pinned install (the URL ref and CLIPMUX_VERSION must be the same value — the
script does not infer a ref from the download URL). Prefix the piped bash,
not curl — curl never forwards the variable:
  curl -fsSL \\
    https://raw.githubusercontent.com/visheshgubrani/vod/<git-sha>/scripts/install.sh \\
    | CLIPMUX_VERSION=<git-sha> bash
  # or: export CLIPMUX_VERSION=<git-sha>  then  curl … | bash

Environment:
  CLIPMUX_DIR                 install prefix (default /opt/clipmux as root, ~/clipmux otherwise)
  CLIPMUX_VERSION             git ref for a fresh remote clone (default: main)
  CLIPMUX_NO_SUDO=1           never escalate; print the command instead
  CLIPMUX_SKIP_INSTALL=1      skip toolchain installs
  NO_COLOR=1                  plain output

A rerun reuses the checkout, .env, secrets and volumes. It does not fetch,
reset, rotate credentials or upgrade. Resume an interrupted install with the
same command.

Contributor setup (Node on the host, not this installer): ./scripts/bootstrap.sh
EOF
}

# Body is a function so `curl | bash` can finish reading the script before we
# reconnect stdin to /dev/tty. Stealing stdin mid-parse would drop the rest.
clipmux_install_main() {
# ── args (before any write or network) ───────────────────────────────────────
WANT_HELP=0
WANT_DOCTOR=0
for arg in "$@"; do
  case "${arg}" in
    -h | --help) WANT_HELP=1 ;;
    --doctor) WANT_DOCTOR=1 ;;
    --) ;;
    -*)
      printf 'unknown argument: %s\n' "${arg}" >&2
      print_help >&2
      exit 2
      ;;
  esac
done

if [ "${WANT_HELP}" = "1" ]; then
  print_help
  exit 0
fi

# ── self / checkout detection ────────────────────────────────────────────────
installer_dir() {
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "bash" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    ( cd "$(dirname "${BASH_SOURCE[0]}")" && pwd )
  fi
}

is_clipmux_checkout() {
  local dir="$1"
  [ -f "${dir}/pnpm-workspace.yaml" ] && [ -f "${dir}/docker-compose.yml" ] && [ -f "${dir}/package.json" ]
}

SCRIPT_DIR="$(installer_dir || true)"
CHECKOUT=""
if [ -n "${SCRIPT_DIR}" ] && is_clipmux_checkout "$(cd "${SCRIPT_DIR}/.." && pwd)"; then
  CHECKOUT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

default_dir() {
  if [ -n "${CHECKOUT}" ]; then
    printf '%s' "${CHECKOUT}"
    return
  fi
  if [ "$(id -u 2>/dev/null || printf 1)" = "0" ]; then
    printf '/opt/clipmux'
  else
    printf '%s/clipmux' "${HOME}"
  fi
}

CLIPMUX_VERSION="${CLIPMUX_VERSION:-main}"
CLIPMUX_DIR="${CLIPMUX_DIR:-$(default_dir)}"

# ── doctor / help stay read-only ─────────────────────────────────────────────
load_detector() {
  local lib="${CLIPMUX_INSTALL_LIB:-}"
  if [ -z "${lib}" ] && [ -n "${CHECKOUT}" ]; then
    lib="${CHECKOUT}/scripts/lib"
  fi
  if [ -n "${lib}" ] && [ -f "${lib}/detect.sh" ]; then
    CLIPMUX_PKG_TABLE="${lib}/pkg-commands.tsv"
    # shellcheck source=lib/detect.sh
    . "${lib}/detect.sh"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || return 1
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/clipmux-detect.XXXXXX")"
  curl -fsSL --max-time 60 "${CLIPMUX_FETCH_BASE}/${CLIPMUX_VERSION}/scripts/lib/detect.sh" \
    >"${tmp}/detect.sh" || return 1
  curl -fsSL --max-time 60 "${CLIPMUX_FETCH_BASE}/${CLIPMUX_VERSION}/scripts/lib/pkg-commands.tsv" \
    >"${tmp}/pkg-commands.tsv" || return 1
  CLIPMUX_PKG_TABLE="${tmp}/pkg-commands.tsv"
  # shellcheck disable=SC1091
  . "${tmp}/detect.sh"
}

report_install_environment() {
  ui_step "environment"
  if [ "${OV_DETECTED:-0}" = "1" ]; then
    ui_detail "$(printf '%s · %s · %s' "${OV_OS}" "${OV_FAMILY}" "${OV_MANAGER:-no package manager}")"
    if [ "$OV_IS_ROOT" = "1" ]; then
      ui_detail "privileges: root (system packages can be installed)"
    elif [ "$OV_CAN_INSTALL" = "1" ]; then
      ui_detail "privileges: passwordless sudo (system packages can be installed)"
    elif [ "$OV_NO_SUDO" = "1" ]; then
      ui_detail "privileges: none — CLIPMUX_NO_SUDO=1, commands are printed instead"
    else
      ui_detail "privileges: none — commands are printed instead of run"
    fi
  else
    ui_detail "$(uname -s 2>/dev/null || echo unknown) (detector not loaded)"
  fi
  if command -v curl >/dev/null 2>&1; then ui_ok "curl"; else ui_warn "curl is missing"; fi
  if command -v git >/dev/null 2>&1; then ui_ok "git"; else ui_warn "git is missing"; fi
  if command -v docker >/dev/null 2>&1; then
    ui_ok "docker $(docker --version 2>/dev/null | head -n 1)"
  else
    ui_warn "docker is missing — Ubuntu/Debian installs it from Docker's apt repository"
  fi
  ui_detail "CLIPMUX_DIR=${CLIPMUX_DIR}"
  ui_detail "CLIPMUX_VERSION=${CLIPMUX_VERSION}"
}

if [ "${WANT_DOCTOR}" = "1" ]; then
  ui_banner
  load_detector && ov_detect_all || true
  report_install_environment
  exit 0
fi

# ── interactive input (piped curl | bash) ────────────────────────────────────
reconnect_tty() {
  if [ -t 0 ]; then
    return 0
  fi
  if [ -r "${CLIPMUX_TTY}" ]; then
    exec <"${CLIPMUX_TTY}"
    return 0
  fi
  return 1
}

if ! reconnect_tty; then
  ui_banner
  die "this installer needs an interactive terminal.
      Run it from a TTY, or:  bash scripts/install.sh
      Piped installs reconnect stdin to /dev/tty; without one, nothing is provisioned."
fi

ui_banner

# ── destination ──────────────────────────────────────────────────────────────
state_path() {
  printf '%s/%s' "${CLIPMUX_DIR}" "${STATE_NAME}"
}

dir_is_ours() {
  local dir="$1"
  [ -f "${dir}/${STATE_NAME}" ] && return 0
  is_clipmux_checkout "${dir}"
}

dir_nonempty() {
  local dir="$1"
  [ -d "${dir}" ] || return 1
  [ -n "$(ls -A "${dir}" 2>/dev/null || true)" ]
}

if dir_nonempty "${CLIPMUX_DIR}" && ! dir_is_ours "${CLIPMUX_DIR}"; then
  die "refusing to install into ${CLIPMUX_DIR} — the directory is not empty and is not a ClipMux install.
      Set CLIPMUX_DIR to an empty path, or remove the unrelated files."
fi

RERUN=0
if [ -f "$(state_path)" ]; then
  RERUN=1
fi

# ── detector (prerequisites) ─────────────────────────────────────────────────
if [ -z "${OV_DETECTED:-}" ] || [ "${OV_DETECTED}" != "1" ]; then
  load_detector || die "could not load the OS detector (need curl, or run from a checkout)"
  ov_detect_all
fi

case "${OV_OS}" in
  macos | linux) ;;
  *)
    die "unsupported operating system: $(uname -s 2>/dev/null || echo unknown)"
    ;;
esac

# ── Docker ───────────────────────────────────────────────────────────────────
docker_cmd() {
  # shellcheck disable=SC2086
  ${CLIPMUX_DOCKER:-docker} "$@"
}

docker_cli_present() {
  command -v docker >/dev/null 2>&1
}

docker_works() {
  docker_cmd info >/dev/null 2>&1
}

select_docker() {
  if [ -n "${CLIPMUX_DOCKER:-}" ] && docker_works; then
    export CLIPMUX_DOCKER
    return 0
  fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    CLIPMUX_DOCKER="docker"
    export CLIPMUX_DOCKER
    return 0
  fi
  if [ "${CLIPMUX_NO_SUDO:-0}" != "1" ] && command -v sudo >/dev/null 2>&1; then
    if sudo -n docker info >/dev/null 2>&1; then
      CLIPMUX_DOCKER="sudo -n docker"
      export CLIPMUX_DOCKER
      return 0
    fi
  fi
  return 1
}

debian_docker_supported() {
  local id version
  id="${OV_DISTRO_ID}"
  version="$(ov_read_os_key "${CLIPMUX_OS_RELEASE_FILE:-/etc/os-release}" VERSION_ID || printf '')"
  case "${id}" in
    ubuntu)
      case "${version}" in
        22.04 | 24.04 | 24.10 | 25.04) return 0 ;;
      esac
      ;;
    debian)
      case "${version}" in
        12 | 13) return 0 ;;
      esac
      ;;
  esac
  return 1
}

install_docker_engine() {
  if docker_works; then
    ui_ok "Docker already usable — leaving the existing installation alone"
    return 0
  fi
  if docker_cli_present; then
    die "Docker is installed but the daemon is not usable.
      Start the Docker daemon (or Docker Desktop) and re-run.
      The installer will not reinstall or upgrade an existing Docker installation."
  fi
  if [ "${OV_FAMILY}" != "debian" ] || ! debian_docker_supported; then
    if [ "${OV_OS}" = "macos" ]; then
      die "Docker Desktop is required on macOS: https://docs.docker.com/desktop/"
    fi
    die "install Docker Engine from https://docs.docker.com/engine/install/ then re-run.
      Automatic Engine install is only offered on supported Ubuntu/Debian releases."
  fi
  if [ "${CLIPMUX_SKIP_DOCKER_INSTALL:-0}" = "1" ]; then
    ui_warn "CLIPMUX_SKIP_DOCKER_INSTALL=1 — not installing Docker"
    return 1
  fi
  if [ "$OV_CAN_INSTALL" != "1" ]; then
    die "Docker Engine is missing and this user may not install packages.
      Install it from https://docs.docker.com/engine/install/ then re-run."
  fi
  ui_step "installing Docker Engine from Docker's apt repository"
  local run
  if [ "$OV_IS_ROOT" = "1" ]; then run="sh -c"; else run="sudo sh -c"; fi
  ${run} 'apt-get update -qq && apt-get install -y ca-certificates curl' >/dev/null
  ${run} 'install -m 0755 -d /etc/apt/keyrings'
  ${run} 'curl -fsSL https://download.docker.com/linux/'"${OV_DISTRO_ID}"'/gpg -o /etc/apt/keyrings/docker.asc'
  ${run} 'chmod a+r /etc/apt/keyrings/docker.asc'
  local codename
  codename="$(ov_read_os_key "${CLIPMUX_OS_RELEASE_FILE:-/etc/os-release}" VERSION_CODENAME || printf '')"
  ${run} "printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${OV_DISTRO_ID} ${codename} stable\\n' \"\$(dpkg --print-architecture)\" > /etc/apt/sources.list.d/docker.list"
  ${run} 'apt-get update -qq && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
  hash -r
}

if [ "${RERUN}" = "1" ]; then
  ui_ok "existing ClipMux install at ${CLIPMUX_DIR} — reusing checkout, config, secrets and volumes"
else
  ui_step "install prefix ${CLIPMUX_DIR}"
fi

if [ "${CLIPMUX_SKIP_PROVISION:-0}" = "1" ]; then
  ui_ok "CLIPMUX_SKIP_PROVISION=1 — stopping before clone, Docker install, or the wizard"
  ui_detail "CLIPMUX_DIR=${CLIPMUX_DIR}"
  ui_detail "CLIPMUX_VERSION=${CLIPMUX_VERSION}"
  ui_detail "rerun=${RERUN}"
  if select_docker; then
    ui_detail "docker=${CLIPMUX_DOCKER}"
  else
    ui_detail "docker=unavailable"
  fi
  exit 0
fi

if [ "${RERUN}" != "1" ]; then
  command -v curl >/dev/null 2>&1 || {
    if [ "$OV_CAN_INSTALL" = "1" ] && ov_run_pkg curl; then
      ui_ok "curl installed"
    else
      die "curl is required"
    fi
  }
  command -v git >/dev/null 2>&1 || {
    if [ "$OV_CAN_INSTALL" = "1" ] && ov_run_pkg git; then
      ui_ok "git installed"
    else
      die "git is required to clone ClipMux"
    fi
  }
  if ! select_docker; then
    if docker_cli_present; then
      die "Docker is installed but the daemon is not usable.
        Start the Docker daemon (or Docker Desktop) and re-run.
        The installer will not reinstall or upgrade an existing Docker installation."
    fi
    install_docker_engine
    select_docker || die "Docker Engine is installed but not usable by this user yet"
  else
    ui_ok "Docker (${CLIPMUX_DOCKER})"
  fi
else
  select_docker || ui_warn "Docker is not reachable on this rerun — the wizard will report it"
fi

# ── fetch checkout (fresh remote only) ───────────────────────────────────────
write_state() {
  local commit="$1"
  umask 077
  mkdir -p "${CLIPMUX_DIR}"
  cat >"$(state_path)" <<EOF
owner=install.sh
version=${CLIPMUX_VERSION}
commit=${commit}
dir=${CLIPMUX_DIR}
EOF
}

if [ "${RERUN}" != "1" ] && ! is_clipmux_checkout "${CLIPMUX_DIR}"; then
  ui_step "cloning ${CLIPMUX_REPO} @ ${CLIPMUX_VERSION}"
  mkdir -p "$(dirname "${CLIPMUX_DIR}")"
  if [ -d "${CLIPMUX_DIR}" ]; then
    rmdir "${CLIPMUX_DIR}" 2>/dev/null || true
  fi
  if ! git clone --depth 1 --branch "${CLIPMUX_VERSION}" "${CLIPMUX_REPO}" "${CLIPMUX_DIR}" 2>/dev/null; then
    git clone "${CLIPMUX_REPO}" "${CLIPMUX_DIR}"
    git -C "${CLIPMUX_DIR}" checkout "${CLIPMUX_VERSION}"
  fi
fi

if is_clipmux_checkout "${CLIPMUX_DIR}"; then
  COMMIT="$(git -C "${CLIPMUX_DIR}" rev-parse HEAD 2>/dev/null || printf unknown)"
  if [ "${RERUN}" != "1" ] || [ ! -f "$(state_path)" ]; then
    write_state "${COMMIT}"
  fi
  ui_ok "checkout ${COMMIT}"
else
  die "${CLIPMUX_DIR} is not a ClipMux checkout"
fi

# ── hand off to bootstrap (Node/pnpm + host-install wizard + deploy) ────────
cd "${CLIPMUX_DIR}"
ui_step "handing over to the setup wizard (host-install, deploy enabled)"
export CLIPMUX_DOCKER
exec ./scripts/bootstrap.sh --host-install --deploy --target deploy
}

clipmux_install_main "$@"
