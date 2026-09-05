#!/usr/bin/env bash
#
# OpenVOD installer — one terminal session to log into Cloudflare + Modal,
# create R2 buckets / CORS, deploy workers + the GPU pipeline, and write
# .dev.vars. R2 S3 access keys still have to be pasted from the dashboard
# (Wrangler cannot mint them).
#
# Usage:
#   scripts/bootstrap.sh
#   scripts/bootstrap.sh --force          # overwrite existing .dev.vars
#   scripts/bootstrap.sh --runtime docker
#   scripts/bootstrap.sh --skip-deploy    # provision + env files only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
HELPER="$SCRIPT_DIR/lib/openvod_setup.py"
API_VARS="$REPO_ROOT/server/.dev.vars"
DELIVERY_VARS="$REPO_ROOT/delivery/.dev.vars"
TMPDIR=""
FORCE=0
SKIP_DEPLOY=0
RUNTIME=""

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_YEL=$'\033[33m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_CYAN=""; C_GREEN=""; C_RED=""; C_YEL=""; C_RESET=""
fi

STEP=0
STEPS=9

usage() {
  cat <<'EOF'
OpenVOD installer

  scripts/bootstrap.sh
  scripts/bootstrap.sh --force
  scripts/bootstrap.sh --runtime workers|docker
  scripts/bootstrap.sh --skip-deploy
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --runtime)
      RUNTIME="${2:-}"
      if [[ "$RUNTIME" != "workers" && "$RUNTIME" != "docker" ]]; then
        echo "runtime must be workers or docker" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

cleanup() {
  if [[ -n "$TMPDIR" && -d "$TMPDIR" ]]; then
    rm -rf "$TMPDIR"
  fi
}
trap cleanup EXIT
TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/openvod-XXXXXX")"
chmod 700 "$TMPDIR"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$TMPDIR/.config}"

banner() {
  echo
  echo "${C_CYAN}  ╔══════════════════════════════════════════════════════╗${C_RESET}"
  echo "${C_CYAN}  ║${C_RESET}  ${C_BOLD}OpenVOD${C_RESET}  ·  install on your Cloudflare + Modal   ${C_CYAN}║${C_RESET}"
  echo "${C_CYAN}  ╚══════════════════════════════════════════════════════╝${C_RESET}"
  echo "${C_DIM}  Wrangler creates buckets and deploys workers."
  echo "  You paste R2 S3 keys (dashboard) and a Postgres URL.${C_RESET}"
  echo
}

step() {
  STEP=$((STEP + 1))
  echo
  echo "${C_BOLD}${C_CYAN}▸  ${STEP}/${STEPS}  $1${C_RESET}"
}

ok() { echo "  ${C_GREEN}✓${C_RESET} $1"; }
warn() { echo "  ${C_YEL}!${C_RESET} $1"; }
fail() { echo "  ${C_RED}✗${C_RESET} $1" >&2; }
info() { echo "  ${C_DIM}→${C_RESET} $1"; }

die() {
  fail "$1"
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing '$1' — install it and re-run"
}

prompt() {
  local label="$1"
  local def="${2:-}"
  local val=""
  if [[ -n "$def" ]]; then
    read -r -p "  ${label} [${def}]: " val || true
    printf '%s' "${val:-$def}"
  else
    read -r -p "  ${label}: " val || true
    printf '%s' "$val"
  fi
}

prompt_secret() {
  local label="$1"
  local val=""
  read -r -s -p "  ${label}: " val || true
  echo >&2
  printf '%s' "$val"
}

open_url() {
  local url="$1"
  info "$url"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  fi
}

w_api() { (cd "$REPO_ROOT/server" && pnpm exec wrangler "$@"); }
w_del() { (cd "$REPO_ROOT/delivery" && pnpm exec wrangler "$@"); }

ensure_workspace() {
  if [[ ! -f "$REPO_ROOT/pnpm-workspace.yaml" ]]; then
    die "run this from the OpenVOD repo (scripts/bootstrap.sh)"
  fi
  if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
    info "installing workspace (pnpm install)…"
    (cd "$REPO_ROOT" && pnpm install)
  fi
}

logged_into_cf() {
  local out
  out="$(w_api whoami 2>&1 || true)"
  if echo "$out" | grep -qiE 'not authenticated|please run `?wrangler login`?'; then
    return 1
  fi
  printf '%s' "$out" | python3 "$HELPER" parse-account-id >/dev/null 2>&1
}

create_bucket() {
  local name="$1"
  local out=""
  if out="$(w_api r2 bucket create "$name" 2>&1)"; then
    ok "created R2 bucket ${name}"
    return 0
  fi
  if echo "$out" | grep -qiE 'already exists|409|Duplicate'; then
    ok "R2 bucket ${name} already exists"
    return 0
  fi
  echo "$out" >&2
  die "failed to create R2 bucket ${name}"
}

apply_cors() {
  local bucket="$1"
  local origins="$2"
  local cors="$TMPDIR/cors.json"
  python3 - "$cors" "$origins" <<'PY'
import json, sys
path, origins = sys.argv[1], sys.argv[2]
origin_list = [o.strip() for o in origins.split(",") if o.strip()]
if not origin_list:
    origin_list = ["http://localhost:3000"]
doc = {
    "rules": [
        {
            "allowed": {
                "origins": origin_list,
                "methods": ["GET", "PUT", "HEAD"],
                "headers": ["*"],
            },
            "exposeHeaders": ["ETag"],
            "maxAgeSeconds": 3600,
        }
    ]
}
open(path, "w").write(json.dumps(doc))
PY
  w_api r2 bucket cors set "$bucket" --file "$cors" --force >/dev/null 2>&1 \
    || w_api r2 bucket cors set "$bucket" --file "$cors" >/dev/null
  ok "CORS on ${bucket} (origins: ${origins})"
}

write_env_files() {
  umask 077
  cat > "$API_VARS" <<EOF
# Generated by scripts/bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_URL=$DATABASE_URL
DB_DRIVER=$DB_DRIVER
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
BETTER_AUTH_URL=$BETTER_AUTH_URL
FRONTEND_URL=$FRONTEND_URL
BACKEND_URL=$BACKEND_URL
CORS_ORIGINS=$CORS_ORIGINS
ACCOUNT_ID=$ACCOUNT_ID
R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY
RAW_BUCKET_NAME=$RAW_BUCKET_NAME
TRANSCODED_BUCKET_NAME=$TRANSCODED_BUCKET_NAME
MODAL_WEBHOOK_URL=$MODAL_WEBHOOK_URL
TRANSCODE_INGEST_SECRET=$TRANSCODE_INGEST_SECRET
JWT_SECRET=$JWT_SECRET
DELIVERY_URL=$DELIVERY_URL
INTERNAL_SWEEP_SECRET=$INTERNAL_SWEEP_SECRET
GROQ_API_KEY=$GROQ_API_KEY
EOF
  cat > "$DELIVERY_VARS" <<EOF
# Generated by scripts/bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
JWT_SECRET=$JWT_SECRET
DEFAULT_POLICY=public
DELIVERY_DEBUG=false
EOF
  ok "wrote server/.dev.vars and delivery/.dev.vars"
}

push_worker_secrets() {
  local dir="$1"
  local json="$2"
  (cd "$dir" && pnpm exec wrangler secret bulk "$json")
}

banner
need python3
need openssl
need pnpm
ensure_workspace

if [[ -f "$API_VARS" && "$FORCE" != "1" ]]; then
  die "server/.dev.vars already exists. Re-run with --force to overwrite."
fi

# ── 1. runtime ────────────────────────────────────────────────────────────
step "API runtime"
if [[ -z "$RUNTIME" ]]; then
  echo "    ${C_DIM}workers${C_RESET}  Cloudflare Worker API + Neon  (default)"
  echo "    ${C_DIM}docker${C_RESET}   Node API + Compose Postgres + web image"
  RUNTIME="$(prompt "runtime" "workers")"
fi
if [[ "$RUNTIME" == "docker" ]]; then
  DB_DRIVER="pg"
else
  RUNTIME="workers"
  DB_DRIVER="neon-http"
fi
ok "runtime=${RUNTIME}  DB_DRIVER=${DB_DRIVER}"

RAW_BUCKET_NAME="$(prompt "raw upload bucket name" "openvod-raw")"
TRANSCODED_BUCKET_NAME="$(prompt "transcoded bucket name" "openvod-transcoded")"
FRONTEND_URL="$(prompt "dashboard origin (CORS)" "http://localhost:3000")"
CORS_ORIGINS="$FRONTEND_URL"

# ── 2. Cloudflare login ───────────────────────────────────────────────────
step "Cloudflare login (Wrangler)"
info "Wrangler will print a URL — open it and approve the account."
if logged_into_cf; then
  ok "already logged in"
else
  w_api login
  logged_into_cf || die "wrangler login did not complete"
  ok "logged in"
fi

WHOAMI="$(w_api whoami 2>&1 || true)"
PARSED_ID="$(printf '%s' "$WHOAMI" | python3 "$HELPER" parse-account-id 2>/dev/null || true)"
ACCOUNT_ID="${ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-$PARSED_ID}}"
if [[ -z "$ACCOUNT_ID" ]]; then
  ACCOUNT_ID="$(prompt "Cloudflare Account ID (32-hex)")"
fi
[[ -n "$ACCOUNT_ID" ]] || die "Cloudflare Account ID is required"
ok "account ${ACCOUNT_ID}"

# ── 3. R2 buckets ─────────────────────────────────────────────────────────
step "Create R2 buckets + CORS"
create_bucket "$RAW_BUCKET_NAME"
create_bucket "$TRANSCODED_BUCKET_NAME"
apply_cors "$RAW_BUCKET_NAME" "$FRONTEND_URL"
python3 "$HELPER" patch-delivery-bucket "$REPO_ROOT" "$TRANSCODED_BUCKET_NAME"
ok "delivery/wrangler.jsonc → bucket ${TRANSCODED_BUCKET_NAME}"

# ── 4. R2 S3 keys (dashboard) ─────────────────────────────────────────────
step "R2 S3 API token (paste from dashboard)"
echo "  Wrangler can create buckets, but ${C_BOLD}not${C_RESET} S3 access keys."
echo "  Create a token with ${C_BOLD}Object Read & Write${C_RESET} on both buckets, then paste."
open_url "https://dash.cloudflare.com/${ACCOUNT_ID}/r2/api-tokens"
R2_ACCESS_KEY_ID="$(prompt "R2 Access Key ID")"
[[ -n "$R2_ACCESS_KEY_ID" ]] || die "R2 Access Key ID is required"
R2_SECRET_ACCESS_KEY="$(prompt_secret "R2 Secret Access Key")"
[[ -n "$R2_SECRET_ACCESS_KEY" ]] || die "R2 Secret Access Key is required"
ok "R2 credentials captured (not printed)"

# ── 5. Postgres ───────────────────────────────────────────────────────────
step "Postgres"
if [[ "$RUNTIME" == "docker" ]]; then
  DATABASE_URL="postgresql://postgres:postgres@postgres:5432/vod_dev"
  ok "Compose will provide Postgres (DATABASE_URL set for the api container)"
else
  echo "  Create a Neon project (or any Postgres) and paste the URI."
  open_url "https://console.neon.tech"
  DATABASE_URL="$(prompt "DATABASE_URL")"
  [[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is required for the Workers path"
  ok "database URL captured"
fi

GROQ_API_KEY="$(prompt "GROQ_API_KEY (optional, AI subtitles)" "")"

BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
JWT_SECRET="$(openssl rand -hex 32)"
INTERNAL_SWEEP_SECRET="$(openssl rand -hex 32)"
TRANSCODE_INGEST_SECRET="$(openssl rand -hex 32)"
BETTER_AUTH_URL="http://localhost:8787"
BACKEND_URL="http://localhost:8787"
if [[ "$RUNTIME" == "docker" ]]; then
  FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
fi
MODAL_WEBHOOK_URL=""
DELIVERY_URL=""
write_env_files

# ── 6. Modal ──────────────────────────────────────────────────────────────
step "Modal login + secrets + deploy"
if ! command -v modal >/dev/null 2>&1; then
  info "installing Modal CLI…"
  python3 -m pip install --user -q modal 2>/dev/null \
    || python3 -m pip install --user --break-system-packages -q modal 2>/dev/null \
    || pipx install modal 2>/dev/null \
    || true
  export PATH="${HOME}/.local/bin:${PATH}"
fi
command -v modal >/dev/null 2>&1 || die "modal CLI not found on PATH — install it (pip install modal) and re-run"

if modal profile current >/dev/null 2>&1 || modal token list >/dev/null 2>&1; then
  ok "Modal CLI already authenticated"
else
  info "Modal will print a URL — approve it in the browser."
  modal setup || modal token new
fi

R2_JSON="$TMPDIR/r2-creds.json"
GROQ_JSON="$TMPDIR/groq-creds.json"
umask 077
python3 - "$R2_JSON" "$ACCOUNT_ID" "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" \
  "$TRANSCODED_BUCKET_NAME" "$TRANSCODE_INGEST_SECRET" "$RAW_BUCKET_NAME" <<'PY'
import json, sys
path, account, key, secret, tbucket, ingest, raw = sys.argv[1:8]
open(path, "w").write(json.dumps({
    "R2_ACCOUNT_ID": account,
    "R2_ACCESS_KEY_ID": key,
    "R2_SECRET_ACCESS_KEY": secret,
    "R2_BUCKET_NAME": tbucket,
    "TRANSCODE_INGEST_SECRET": ingest,
    "ALLOWED_SOURCE_BUCKETS": raw,
    "ALLOWED_CALLBACK_HOSTS": "localhost",
}))
PY
python3 - "$GROQ_JSON" "${GROQ_API_KEY:-unused}" <<'PY'
import json, sys
open(sys.argv[1], "w").write(json.dumps({"GROQ_API_KEY": sys.argv[2] or "unused"}))
PY
python3 "$HELPER" modal-secret r2-creds "$R2_JSON"
python3 "$HELPER" modal-secret groq-creds "$GROQ_JSON"
ok "Modal secrets r2-creds + groq-creds"

if [[ "$SKIP_DEPLOY" == "1" ]]; then
  warn "skipping Modal deploy (--skip-deploy)"
else
  info "deploying GPU pipeline (first image build can take several minutes)…"
  MODAL_OUT="$TMPDIR/modal-deploy.txt"
  if (cd "$REPO_ROOT/transcoding" && modal deploy main.py) | tee "$MODAL_OUT"; then
    if MODAL_WEBHOOK_URL="$(python3 "$HELPER" parse-modal-url < "$MODAL_OUT")"; then
      python3 "$HELPER" upsert-env "$API_VARS" MODAL_WEBHOOK_URL "$MODAL_WEBHOOK_URL"
      ok "MODAL_WEBHOOK_URL=${MODAL_WEBHOOK_URL}"
    else
      warn "deploy succeeded but URL parse failed — set MODAL_WEBHOOK_URL by hand"
    fi
  else
    warn "modal deploy failed — run: cd transcoding && modal deploy main.py"
  fi
fi

# ── 7. Deploy delivery ────────────────────────────────────────────────────
step "Deploy delivery worker"
if [[ "$SKIP_DEPLOY" == "1" ]]; then
  warn "skipped"
else
  DEL_OUT="$TMPDIR/delivery-deploy.txt"
  if w_del deploy | tee "$DEL_OUT"; then
    DELIVERY_URL="$(python3 "$HELPER" parse-workers-url < "$DEL_OUT" || true)"
    if [[ -n "${DELIVERY_URL:-}" ]]; then
      python3 "$HELPER" upsert-env "$API_VARS" DELIVERY_URL "$DELIVERY_URL"
      ok "DELIVERY_URL=${DELIVERY_URL}"
    else
      warn "could not parse delivery URL — set DELIVERY_URL after checking wrangler output"
    fi
    DEL_SECRETS="$TMPDIR/delivery-secrets.json"
    python3 - "$DEL_SECRETS" "$JWT_SECRET" <<'PY'
import json, sys
open(sys.argv[1], "w").write(json.dumps({"JWT_SECRET": sys.argv[2]}))
PY
    push_worker_secrets "$REPO_ROOT/delivery" "$DEL_SECRETS"
    ok "delivery JWT_SECRET uploaded"
  else
    warn "delivery deploy failed — cd delivery && pnpm exec wrangler deploy"
  fi
fi

# ── 8. Deploy API ─────────────────────────────────────────────────────────
step "Deploy API"
if [[ "$SKIP_DEPLOY" == "1" ]]; then
  warn "skipped"
elif [[ "$RUNTIME" == "docker" ]]; then
  command -v docker >/dev/null 2>&1 || die "docker is required for --runtime docker"
  info "starting Compose (postgres + api + web)…"
  (cd "$REPO_ROOT" && docker compose up -d)
  BETTER_AUTH_URL="http://localhost:8787"
  BACKEND_URL="http://localhost:8787"
  python3 "$HELPER" upsert-env "$API_VARS" BETTER_AUTH_URL "$BETTER_AUTH_URL"
  python3 "$HELPER" upsert-env "$API_VARS" BACKEND_URL "$BACKEND_URL"
  ok "Compose is up — API http://localhost:8787  dashboard http://localhost:3000"
else
  API_OUT="$TMPDIR/api-deploy.txt"
  if w_api deploy | tee "$API_OUT"; then
    API_URL="$(python3 "$HELPER" parse-workers-url < "$API_OUT" || true)"
    if [[ -n "${API_URL:-}" ]]; then
      BETTER_AUTH_URL="$API_URL"
      BACKEND_URL="$API_URL"
      python3 "$HELPER" upsert-env "$API_VARS" BETTER_AUTH_URL "$BETTER_AUTH_URL"
      python3 "$HELPER" upsert-env "$API_VARS" BACKEND_URL "$BACKEND_URL"
      ok "API ${API_URL}"
    else
      warn "could not parse API workers.dev URL"
    fi
    # Refresh MODAL/DELIVERY from files after upserts
    # shellcheck disable=SC1090
    set -a
    # Do not source .dev.vars (can contain spaces). Re-read keys we need.
    set +a
    API_SECRETS="$TMPDIR/api-secrets.json"
    python3 - "$API_SECRETS" "$API_VARS" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[2])
wanted = [
    "DATABASE_URL", "DB_DRIVER", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL",
    "FRONTEND_URL", "BACKEND_URL", "CORS_ORIGINS", "ACCOUNT_ID",
    "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "RAW_BUCKET_NAME",
    "TRANSCODED_BUCKET_NAME", "MODAL_WEBHOOK_URL", "TRANSCODE_INGEST_SECRET",
    "JWT_SECRET", "DELIVERY_URL", "INTERNAL_SWEEP_SECRET", "GROQ_API_KEY",
]
env = {}
for line in path.read_text().splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, _, v = line.partition("=")
    if k in wanted:
        env[k] = v
open(sys.argv[1], "w").write(json.dumps(env))
PY
    push_worker_secrets "$REPO_ROOT/server" "$API_SECRETS"
    ok "API secrets uploaded"
    info "pushing schema (pnpm db:push)…"
    (cd "$REPO_ROOT" && DATABASE_URL="$DATABASE_URL" pnpm db:push) || warn "db:push failed — run pnpm db:push once DATABASE_URL is reachable"
  else
    warn "API deploy failed — cd server && pnpm exec wrangler deploy"
  fi
fi

# Refresh callback hosts now that we know the API hostname
if [[ "$SKIP_DEPLOY" != "1" && -n "${BACKEND_URL:-}" && -f "$R2_JSON" ]]; then
  API_HOST="$(python3 - "$BACKEND_URL" <<'PY'
from urllib.parse import urlparse
import sys
print(urlparse(sys.argv[1]).hostname or "localhost")
PY
)"
  python3 - "$R2_JSON" "$API_HOST" <<'PY'
import json, sys
path, host = sys.argv[1], sys.argv[2]
data = json.loads(open(path).read())
hosts = {"localhost", host}
data["ALLOWED_CALLBACK_HOSTS"] = ",".join(sorted(hosts))
open(path, "w").write(json.dumps(data))
PY
  python3 "$HELPER" modal-secret r2-creds "$R2_JSON" || warn "could not refresh ALLOWED_CALLBACK_HOSTS on Modal"
fi

# ── 9. Done ───────────────────────────────────────────────────────────────
step "Next"
echo
echo "  ${C_BOLD}Local dashboard${C_RESET}   pnpm --filter web dev   →  ${FRONTEND_URL}/setup"
echo "  ${C_BOLD}Health${C_RESET}            curl ${BACKEND_URL:-http://localhost:8787}/health/config"
echo "  ${C_BOLD}Env files${C_RESET}         server/.dev.vars  delivery/.dev.vars"
echo
echo "  ${C_DIM}If Modal URL / delivery URL were empty, paste them into server/.dev.vars"
echo "  and re-upload secrets: cd server && pnpm exec wrangler secret bulk …${C_RESET}"
echo
ok "OpenVOD bootstrap finished"
echo
