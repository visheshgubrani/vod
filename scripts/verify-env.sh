#!/usr/bin/env bash
#
# OpenVOD environment verifier (zero dependencies).
# Reads server/.dev.vars and prints a checklist of what is configured,
# WITHOUT printing secret values. Optionally probes the live API.
#
# Usage:
#   scripts/verify-env.sh                # local file checks only
#   scripts/verify-env.sh <api-url>      # also curl <api-url>/health/config

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARS="$ROOT/server/.dev.vars"
DELIVERY_VARS="$ROOT/delivery/.dev.vars"

echo "OpenVOD environment verifier"
echo "============================"

if [[ ! -f "$VARS" ]]; then
  echo "✗ server/.dev.vars missing — run ./scripts/bootstrap.sh first"
  exit 1
fi

check() { # check <var> <label>
  local val
  val="$(grep -E "^${1}=" "$VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' )"
  if [[ -n "$val" && "$val" != "your-*" && "$val" != *change-me* && "$val" != "changeme" ]]; then
    echo "✓ ${2} (${1})"
  else
    echo "✗ ${2} (${1}) — missing or placeholder"
    FAILED=1
  fi
}

advisory() { # advisory <var> <label>
  local val
  val="$(grep -E "^${1}=" "$VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' )"
  if [[ -n "$val" && "$val" != "your-*" && "$val" != *change-me* && "$val" != "changeme" ]]; then
    echo "✓ ${2} (${1})"
  else
    echo "○ ${2} (${1}) — optional / advisory"
  fi
}

FAILED=0

check DATABASE_URL "Postgres connection URL"
advisory DB_DRIVER "DB driver (neon-http | pg)"
check ACCOUNT_ID "Cloudflare account id"
check R2_ACCESS_KEY_ID "R2 access key id"
check R2_SECRET_ACCESS_KEY "R2 secret access key"
check RAW_BUCKET_NAME "Raw bucket"
check TRANSCODED_BUCKET_NAME "Transcoded bucket"
check MODAL_WEBHOOK_URL "Modal webhook URL"
check TRANSCODE_INGEST_SECRET "Transcode ingest secret"
check JWT_SECRET "Playback JWT secret (>=32 chars)"
check BETTER_AUTH_SECRET "Auth secret (>=32 chars)"
advisory DELIVERY_URL "Delivery worker base URL"

JWT="$(grep -E '^JWT_SECRET=' "$VARS" | tail -1 | cut -d= -f2- | tr -d '"')"
if [[ -n "$JWT" && "${#JWT}" -lt 32 ]]; then
  echo "✗ JWT_SECRET shorter than 32 chars"
  FAILED=1
fi
BA="$(grep -E '^BETTER_AUTH_SECRET=' "$VARS" | tail -1 | cut -d= -f2- | tr -d '"')"
if [[ -n "$BA" && "${#BA}" -lt 32 ]]; then
  echo "✗ BETTER_AUTH_SECRET shorter than 32 chars"
  FAILED=1
fi

if [[ -f "$DELIVERY_VARS" ]]; then
  DJWT="$(grep -E '^JWT_SECRET=' "$DELIVERY_VARS" | tail -1 | cut -d= -f2- | tr -d '"')"
  if [[ -n "$JWT" && -n "$DJWT" && "$JWT" != "$DJWT" ]]; then
    echo "✗ delivery/.dev.vars JWT_SECRET does not match server/.dev.vars"
    FAILED=1
  elif [[ -n "$DJWT" ]]; then
    echo "✓ delivery/.dev.vars JWT_SECRET matches the API"
  fi
else
  echo "○ delivery/.dev.vars missing — copy delivery/.dev.vars.example (JWT_SECRET must match the API)"
fi

echo "----------------------------"
if [[ "${1:-}" != "" ]]; then
  echo "→ Probing ${1%/}/health/config …"
  curl -fsS "${1%/}/health/config" && echo
fi

if [[ "$FAILED" == "1" ]]; then
  echo "❌ Some required values are missing. See server/.dev.vars.example."
  exit 1
fi
echo "✅ All required values look configured."
