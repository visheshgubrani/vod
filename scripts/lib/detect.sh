#!/usr/bin/env bash
#
# ClipMux OS / package-manager detection — the single detector for both languages.
#
# Sourced by scripts/bootstrap.sh, which has to decide what to install *before*
# any Node exists; the TypeScript wizard consumes the same verdict instead of
# carrying a second copy of the table:
#
#   bash scripts/lib/detect.sh --dump      # KEY=value report, no side effects
#
# Everything here is read-only: detection never installs, never escalates and
# never writes. `ov_run_pkg` is the one function that runs anything, and it
# refuses unless the run is root or has passwordless sudo (CLIPMUX_NO_SUDO=1
# refuses outright).
#
# Bash 3.2 compatible on purpose: that is what macOS ships as /bin/bash, and the
# features bash 4 added (associative arrays, bulk line reading, lower-casing
# parameter expansion, namerefs) simply are not there. Everything below therefore
# matches with `case` on one combined string. CI runs this file under a real
# bash 3.2 rather than trusting a syntax grep.

OV_OS='unknown'
OV_DISTRO_ID=''
OV_DISTRO_LIKE=''
OV_FAMILY='unknown'
OV_MANAGER=''
OV_IS_ROOT=0
OV_HAS_SUDO=0
OV_NO_SUDO=0
OV_CAN_INSTALL=0
OV_DETECTED=0

# ov_read_os_key FILE KEY — value of KEY= in an os-release style file.
ov_read_os_key() {
  local file="$1" key="$2" line
  [ -r "$file" ] || return 1
  while IFS= read -r line; do
    case "$line" in
      "$key"=*)
        line="${line#*=}"
        line="${line%\"}"
        line="${line#\"}"
        printf '%s' "$line"
        return 0
        ;;
    esac
  done < "$file"
  return 1
}

# ov_family_from_ids ID ID_LIKE — distro family, from IDs only (pure).
ov_family_from_ids() {
  local all="$1 $2"
  case "$all" in
    *debian* | *ubuntu* | *mint* | *raspbian* | *pop\ * | *pop) printf 'debian' ;;
    *rhel* | *fedora* | *centos* | *rocky* | *almalinux* | *amzn* | *ol\ * | *ol) printf 'rpm' ;;
    *arch* | *manjaro* | *endeavouros*) printf 'arch' ;;
    *suse*) printf 'suse' ;;
    *alpine*) printf 'alpine' ;;
    *) printf 'unknown' ;;
  esac
}

# ov_manager_for FAMILY — the package manager binary to prefer, or ''.
ov_manager_for() {
  case "$1" in
    mac) printf 'brew' ;;
    debian) printf 'apt-get' ;;
    rpm)
      if command -v dnf >/dev/null 2>&1; then printf 'dnf'; elif command -v yum >/dev/null 2>&1; then printf 'yum'; fi
      ;;
    arch) printf 'pacman' ;;
    suse) printf 'zypper' ;;
    alpine) printf 'apk' ;;
    *) printf '' ;;
  esac
}

ov_detect_os() {
  local os_release id like uname_s
  uname_s="${CLIPMUX_UNAME_OVERRIDE:-$(uname -s 2>/dev/null || printf 'unknown')}"
  case "$uname_s" in
    Darwin) OV_OS='macos' ;;
    Linux) OV_OS='linux' ;;
    *) OV_OS='other' ;;
  esac

  if [ "$OV_OS" = 'macos' ]; then
    OV_FAMILY='mac'
  elif [ "$OV_OS" = 'linux' ]; then
    os_release="${CLIPMUX_OS_RELEASE_FILE:-/etc/os-release}"
    id="$(ov_read_os_key "$os_release" ID || printf '')"
    like="$(ov_read_os_key "$os_release" ID_LIKE || printf '')"
    OV_DISTRO_ID="$id"
    OV_DISTRO_LIKE="$like"
    OV_FAMILY="$(ov_family_from_ids "$id" "$like")"
  else
    OV_FAMILY='unknown'
  fi
  OV_MANAGER="$(ov_manager_for "$OV_FAMILY")"
}

ov_detect_privileges() {
  OV_NO_SUDO=0
  [ "${CLIPMUX_NO_SUDO:-0}" = '1' ] && OV_NO_SUDO=1

  OV_IS_ROOT=0
  if [ "$(id -u 2>/dev/null || printf '1')" = '0' ]; then OV_IS_ROOT=1; fi

  OV_HAS_SUDO=0
  if [ "$OV_NO_SUDO" = '0' ] && [ "$OV_IS_ROOT" = '0' ] && command -v sudo >/dev/null 2>&1; then
    # `-n` is the whole point: a password prompt inside a TUI corrupts the
    # terminal, so only passwordless escalation counts as permission.
    if sudo -n true >/dev/null 2>&1; then OV_HAS_SUDO=1; fi
  fi

  OV_CAN_INSTALL=0
  if [ "$OV_NO_SUDO" = '0' ] && { [ "$OV_IS_ROOT" = '1' ] || [ "$OV_HAS_SUDO" = '1' ]; }; then
    OV_CAN_INSTALL=1
  fi
}

ov_detect_all() {
  ov_detect_os
  ov_detect_privileges
  OV_DETECTED=1
}

ov_pkg_table() {
  printf '%s' "${CLIPMUX_PKG_TABLE:-$(dirname "${BASH_SOURCE[0]}")/pkg-commands.tsv}"
}

# ov_pkg_command CAPABILITY — the install command for this family, or nothing.
ov_pkg_command() {
  local want="$1" file line cap fam cmd
  file="$(ov_pkg_table)"
  [ -r "$file" ] || return 1
  while IFS='|' read -r cap fam cmd; do
    case "$cap" in '' | '#'*) continue ;; esac
    if [ "$cap" = "$want" ] && [ "$fam" = "$OV_FAMILY" ]; then
      printf '%s' "$cmd"
      return 0
    fi
  done < "$file"
  return 1
}

# ov_with_sudo COMMAND — the command as the user should run it.
ov_with_sudo() {
  if [ "$OV_IS_ROOT" = '1' ]; then printf '%s' "$1"; else printf 'sudo %s' "$1"; fi
}

# ov_run_pkg CAPABILITY — install it, when we are allowed to.
# Returns non-zero (and prints nothing) when it cannot: the caller then shows the
# command instead. Never prompts for a password.
ov_run_pkg() {
  local cap="$1" cmd
  cmd="$(ov_pkg_command "$cap" || printf '')"
  [ -n "$cmd" ] || return 1
  [ "$OV_DETECTED" = '1' ] || ov_detect_all
  [ "$OV_CAN_INSTALL" = '1' ] || return 1

  if [ "$OV_IS_ROOT" = '1' ]; then
    sh -c "$cmd"
  else
    sudo sh -c "$cmd"
  fi
}

# ov_pkg_hint CAPABILITY — what to tell someone we are not allowed to install for.
ov_pkg_hint() {
  local cap="$1" cmd
  cmd="$(ov_pkg_command "$cap" || printf '')"
  if [ -z "$cmd" ]; then
    printf 'install %s with your package manager' "$cap"
    return 0
  fi
  ov_with_sudo "$cmd"
}

ov_dump() {
  [ "$OV_DETECTED" = '1' ] || ov_detect_all
  printf 'OS=%s\n' "$OV_OS"
  printf 'FAMILY=%s\n' "$OV_FAMILY"
  printf 'DISTRO_ID=%s\n' "$OV_DISTRO_ID"
  printf 'DISTRO_LIKE=%s\n' "$OV_DISTRO_LIKE"
  printf 'MANAGER=%s\n' "$OV_MANAGER"
  printf 'IS_ROOT=%s\n' "$OV_IS_ROOT"
  printf 'HAS_SUDO=%s\n' "$OV_HAS_SUDO"
  printf 'NO_SUDO=%s\n' "$OV_NO_SUDO"
  printf 'CAN_INSTALL=%s\n' "$OV_CAN_INSTALL"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  ov_detect_all
  case "${1:-}" in
    --dump) ov_dump ;;
    *)
      printf 'usage: bash scripts/lib/detect.sh --dump\n' >&2
      exit 2
      ;;
  esac
fi
