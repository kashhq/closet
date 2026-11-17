#!/usr/bin/env bash
# Boots a built image as production runs it (`node dist/main.js`, NODE_ENV=production, the PWA on)
# and checks it serves, so a broken Dockerfile or a runtime dependency that no longer loads blocks the
# publish instead of reaching the homelab (#181). The unit and integration tiers never boot main.ts
# or server.ts: this is their test (vitest.config.mts leaves them out of coverage for it).
#
#   make ci-smoke:       the gate, and the publisher host before it pushes, with a placeholder model
#   nightly.yml, cutout: with the real BiRefNet model (MODELS_DIR), plus one real cutout
#
# Usage: scripts/smoke-image.sh <image>
# Environment:
#   DATABASE_HOST, DATABASE_PORT (5432), DATABASE_USER, DATABASE_PASS, DATABASE_NAME
#       An empty database: the boot must apply the migrations. The container runs on the host's
#       network, so localhost is the host's (make ci-smoke's throwaway Postgres, pgvault-dev on
#       the production host).
#   SMOKE_PORT   where the app listens (3000).
#   MODELS_DIR   a directory holding the verified model (npm run cutout:fetch-model): the app loads it
#                and an uploaded photo must get its cutout. Unset: a placeholder file stands in, which
#                the app refuses on its checksum, so the boot never downloads 940 MB.
#   BOOT_EXPECT_VERSION  the APP_VERSION the image was built with (make ci-smoke: CI_BUILD_VERSION,
#                the publisher's 7-char sha): /health/ready's `version` must equal it, so an image that
#                lost the build arg (and reports `dev`) never ships. Same name and rule as devkit's
#                boot_image.sh, which this script does not use (it boots on the host network).
#
# Checks, each fatal: the app runs as uid APP_UID; /health/ready answers 2xx (and names
# BOOT_EXPECT_VERSION when set); the boot log shows the migrations applied; the login page
# renders in the app shell and its stylesheet and htmx are served; devkit's contract probe passes
# (the health contract, request ids, JSON lines, /metrics; below); with MODELS_DIR, a photo uploaded
# over HTTP is cut out by the model in the image's own onnxruntime; `docker stop` (SIGTERM) exits 0.
# Then the non-root image's two failure modes (docs/operations.md#permissions), each its own boot on
# the migrated database: a root-owned data directory ends the boot naming the chown, and a root-owned
# models directory leaves /health/ready 503 with `storage` down and the chown as its fix.
# Last, README's quick-start compose block (the first yaml fence after `<!-- smoke:quickstart -->`) is
# run with its own Postgres: only the image, the two `<...>` placeholders and the host port are
# substituted, it must reach /health/ready 200, and a recreated container must find the models volume
# as it was (the 940 MB model is not downloaded again). Needs `docker compose`; its Postgres is its own,
# so the DATABASE_* variables above do not apply to it.
# On failure the container's log is printed.
set -euo pipefail

# Match against a snapshot of the container log, never `docker logs | grep -q`: with pipefail,
# grep -q exits on its first match, docker logs dies of SIGPIPE, and the pipeline reports a
# failure for text that was found (the first publish run on main failed this way, 2026-09-28).
log_has() { docker logs "$NAME" >"$WORK/container.log" 2>&1; grep -q "$@" "$WORK/container.log"; }

IMAGE=${1:?usage: scripts/smoke-image.sh <image>}
: "${DATABASE_HOST:?} ${DATABASE_USER:?} ${DATABASE_NAME:?}"
PORT=${SMOKE_PORT:-3000}
BASE="http://127.0.0.1:$PORT"
SMOKE="closet-smoke-$$"
# The container under test: the main boot, then each permission boot (fail and log_has read it).
NAME=$SMOKE
WORK=$(mktemp -d)
# The uid:gid the image's USER (node, from node:22-slim) has, and so the one docs/operations.md
# tells the owner to chown the host directories to: the smoke holds the two to each other.
APP_UID=1000
APP_GID=1000
# Docker volumes, not host directories, stand in for production's bind mounts: the kernel checks a
# root-owned one exactly as it checks a root-owned host directory, while a macOS host directory
# (OrbStack, Docker Desktop) lets every uid write and could not show the failure at all.
DATA="$SMOKE-data" MODELS="$SMOKE-models" ROOT_DATA="$SMOKE-rootdata" ROOT_MODELS="$SMOKE-rootmodels"
BOOT_TIMEOUT_S=60
CUTOUT_TIMEOUT_S=240

log() { echo "[smoke $(date -u +%H:%M:%S)] $*"; }
fail() {
  log "FAIL: $*"
  echo "----- container log ($NAME) -----"
  docker logs "$NAME" 2>&1 | tail -n 200 || true
  exit 1
}
cleanup() {
  docker rm -f "$SMOKE" "$ROOT_DATA" "$ROOT_MODELS" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA" "$MODELS" "$ROOT_DATA" "$ROOT_MODELS" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The same keypair shape production has, made by the image's own web-push (PWA_ENABLED requires them).
keys=$(docker run --rm --entrypoint /app/node_modules/.bin/web-push "$IMAGE" generate-vapid-keys --json)

# volume <name> <uid:gid> [placeholder]: a fresh volume whose root is owned by uid:gid, as a host
# directory chowned (or not) by the owner; `placeholder` adds the stand-in model file. Made as root
# by the image itself, so the smoke needs no other image.
volume() {
  local script="chown -R $2 /v"
  [ "${3:-}" = placeholder ] && script="echo 'placeholder: refused on its checksum' >/v/birefnet_512.onnx && $script"
  docker volume create "$1" >/dev/null
  docker run --rm --user 0 --entrypoint sh -v "$1:/v" "$IMAGE" -c "$script" >/dev/null
}

# start <container> <data volume> <models volume>: the image as production runs it, both
# directories mounted. volume-nocopy: Docker would otherwise copy the image directory's ownership
# into an empty volume and hide a root-owned one.
start() {
  local model=()
  # The real model, read-only, inside the writable models volume (nightly).
  [ -n "${MODELS_DIR:-}" ] && model=(-v "$(cd "$MODELS_DIR" && pwd)/birefnet_512.onnx:/app/models/birefnet_512.onnx:ro")
  docker run -d --name "$1" --network host \
    --mount "type=volume,src=$2,dst=/app/data,volume-nocopy=true" \
    --mount "type=volume,src=$3,dst=/app/models,volume-nocopy=true" \
    ${model[@]+"${model[@]}"} \
    -e PORT="$PORT" \
    -e DATABASE_HOST="$DATABASE_HOST" \
    -e DATABASE_PORT="${DATABASE_PORT:-5432}" \
    -e DATABASE_USER="$DATABASE_USER" \
    -e DATABASE_PASS="${DATABASE_PASS:-}" \
    -e DATABASE_NAME="$DATABASE_NAME" \
    -e ACCESS_TOKEN_SECRET=smoke-test-access-token-secret-not-for-deployment \
    -e PWA_ENABLED=true \
    -e METRICS_ENABLED=true \
    -e APP_ENV=gate \
    -e SITE_URL=https://closet.test \
    -e PUBLIC_VAPID_KEY="$(jq -r .publicKey <<<"$keys")" \
    -e PRIVATE_VAPID_KEY="$(jq -r .privateKey <<<"$keys")" \
    "$IMAGE" >/dev/null
}

volume "$DATA" "$APP_UID:$APP_GID"
# Without MODELS_DIR a placeholder model stands in: refused on its checksum, so the boot never
# downloads 940 MB, and the queue waits for a model as production does when it cannot get one.
if [ -n "${MODELS_DIR:-}" ]; then
  volume "$MODELS" "$APP_UID:$APP_GID"
else
  volume "$MODELS" "$APP_UID:$APP_GID" placeholder
fi

log "starting $IMAGE on :$PORT (database $DATABASE_NAME on $DATABASE_HOST, model: ${MODELS_DIR:-placeholder})"
started=$SECONDS
start "$NAME" "$DATA" "$MODELS"

health="$WORK/health.json"
until [[ "$(curl -s -o "$health" -w '%{http_code}' "$BASE/health/ready")" == 2?? ]]; do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "the container exited during boot"
  [ $((SECONDS - started)) -lt $BOOT_TIMEOUT_S ] || fail "/health/ready did not answer 2xx within ${BOOT_TIMEOUT_S}s"
  sleep 1
done
version=$(jq -r '.version // empty' "$health" 2>/dev/null || true)
log "ok: /health/ready after $((SECONDS - started))s, version ${version:-none}"
uid=$(docker exec "$NAME" id -u)
[ "$uid" = "$APP_UID" ] || fail "the app runs as uid $uid, not $APP_UID (the Dockerfile's USER)"
[ "$(docker exec "$NAME" cat /proc/1/comm)" = node ] || fail "PID 1 is not node: docker stop's SIGTERM would not reach it"
log "ok: running as uid $uid, PID 1 node"
if [ -n "${BOOT_EXPECT_VERSION:-}" ] && [ "$version" != "$BOOT_EXPECT_VERSION" ]; then
  fail "/health/ready reports version '${version:-none}', not the build's '$BOOT_EXPECT_VERSION'"
fi

migrated=$(docker logs "$NAME" 2>&1 | grep -oE 'Applied [0-9]+ Drizzle migration\(s\)' || true)
[ -n "$migrated" ] || fail "the boot log does not show the migrations applied (was the database empty?)"
log "ok: $migrated"

page="$WORK/login.html"
status=$(curl -s -o "$page" -w '%{http_code}' "$BASE/auth/login")
[ "$status" = 200 ] || fail "GET /auth/login answered $status"
# The layout (src/web/layout/layout.tsx): the app name in the title, the boosted body.
grep -qE '<title>[^<]*Closet</title>' "$page" || fail "the login page's <title> does not name the app"
grep -q '<body hx-boost="true"' "$page" || fail "the login page is not in the app shell (no boosted <body>)"
grep -q 'name="password"' "$page" || fail "the login page has no sign-in form"
css=$(grep -oE '/bundle\.css\?v=[^"]+' "$page" | head -n 1)
[ -n "$css" ] || fail "the login page links no /bundle.css"
for asset in "$css" /modules/htmx.min.js; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$asset")
  [ "$status" = 200 ] || fail "GET $asset answered $status"
done
log "ok: /auth/login 200 in the app shell; $css and /modules/htmx.min.js served"

# The licence notices the build generates (scripts/third-party-notices.ts) must ship in the image
# and name both webfonts' OFL (#640).
notices="$WORK/notices.txt"
status=$(curl -s -o "$notices" -w '%{http_code}' "$BASE/THIRD-PARTY-NOTICES.txt")
[ "$status" = 200 ] || fail "GET /THIRD-PARTY-NOTICES.txt answered $status"
grep -q 'SIL OPEN FONT LICENSE' "$notices" || fail "THIRD-PARTY-NOTICES.txt carries no OFL text"
grep -q '^htmx.org  (' "$notices" || fail "THIRD-PARTY-NOTICES.txt has no entry for htmx.org"
log "ok: /THIRD-PARTY-NOTICES.txt served with the OFL text"

# The observability contract (observability.md; src/logger.ts, src/request-context.ts,
# src/metrics/, src/web/health/), asserted by devkit's probe the way every app's smoke asserts
# it: /health/live answers 200; /health/ready is the contract's up|down body with every check
# (the timers and the cutout queue run here, so all are up) and the build's version; a request gets a fresh 12-hex X-Request-ID (an inbound one is never kept) that its
# JSON access line carries, with ts, level, logger, msg and the build's version; /metrics
# serves app_info{version=BOOT_EXPECT_VERSION} 1 and the request histogram, every job outcome
# is in the allowed set, and a proxied scrape is a 404.
log "contract probe"
"$(dirname "$0")/../devkit/bin/contract_probe.sh" "$BASE" \
  --live /health/live \
  --health /health/ready \
  --request-id /auth/login \
  --metrics /metrics --require-metric app_info --require-metric http_request_duration_seconds \
  --require-metric http_request_db_statements \
  --json-log "$NAME" || fail "the observability contract probe failed (lines above)"
log "ok: observability contract"

if [ -n "${MODELS_DIR:-}" ]; then
  # A red shirt on a pale backdrop, drawn by the image's own sharp.
  docker run --rm --entrypoint node "$IMAGE" -e "
    const shirt = Buffer.from('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"1600\"><path d=\"M380 300 L520 240 Q600 300 680 240 L820 300 L960 520 L840 600 L820 540 L820 1300 L380 1300 L380 540 L360 600 L240 520 Z\" fill=\"#b3262a\"/></svg>');
    require('sharp')({ create: { width: 1200, height: 1600, channels: 3, background: '#ece8e1' } })
      .composite([{ input: shirt }]).jpeg({ quality: 90 }).toBuffer()
      .then((jpeg) => process.stdout.write(jpeg));
  " >"$WORK/photo.jpg"

  password=Smoke-test-1
  cookie=$(curl -s -o /dev/null -D - -H "Origin: $BASE" \
    --data-urlencode email=smoke@closet.invalid --data-urlencode password=$password \
    --data-urlencode confirmPassword=$password "$BASE/auth/register" |
    grep -oiE '^set-cookie: access_token=[^;]+' | sed -E 's/^[^:]+: //')
  [ -n "$cookie" ] || fail "registering the smoke account set no session"

  location=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Origin: $BASE" -H "Cookie: $cookie" \
    --data-urlencode 'name=Smoke shirt' --data-urlencode category=shirt "$BASE/wardrobe")
  garment=$(grep -oE '/wardrobe/[0-9]+' <<<"$location" | grep -oE '[0-9]+$' || true)
  [ -n "$garment" ] || fail "creating a garment redirected to '$location'"

  status=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -H "Cookie: $cookie" \
    -F "photo=@$WORK/photo.jpg;type=image/jpeg" "$BASE/wardrobe/$garment/photo")
  [ "$status" = 303 ] || fail "uploading the photo of garment $garment answered $status"
  log "uploaded a photo to garment $garment; waiting for its cutout"

  queued=$SECONDS
  until log_has "Cutout ready: garment $garment "; do
    if log_has -E "Cutout (failed|discarded)[^:]*: garment $garment "; then
      fail "the model did not cut out garment $garment's photo"
    fi
    [ $((SECONDS - queued)) -lt $CUTOUT_TIMEOUT_S ] || fail "no cutout for garment $garment within ${CUTOUT_TIMEOUT_S}s"
    sleep 2
  done
  log "ok: $(docker logs "$NAME" 2>&1 | grep -oE "Cutout ready: garment $garment [^[:cntrl:]]*" | head -n 1)"
fi

docker stop -t 15 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$code" = 0 ] || fail "docker stop: the process exited $code, not 0"
log_has 'SIGTERM: shutting down' || fail "the log does not show the SIGTERM shutdown"
log "ok: SIGTERM shut it down with exit 0"

# A root-owned data directory (the owner skipped the chown): the boot refuses it, naming the fix
# (src/main.ts), instead of a first upload's bare EACCES stack.
NAME=$ROOT_DATA
volume "$ROOT_DATA" 0:0
start "$NAME" "$ROOT_DATA" "$MODELS"
waited=$SECONDS
while [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ]; do
  [ $((SECONDS - waited)) -lt $BOOT_TIMEOUT_S ] || fail "a root-owned /app/data did not end the boot within ${BOOT_TIMEOUT_S}s"
  sleep 1
done
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" != 0 ] || fail "a root-owned /app/data: the boot exited 0"
log_has -F "DATA_PATH /app/data is not writable by this process (EACCES): chown -R $APP_UID:$APP_GID the host directory mounted at DATA_PATH; docs/operations.md#permissions" \
  || fail "a root-owned /app/data: the boot log does not name the chown"
log "ok: a root-owned /app/data ends the boot with the chown named"

# A root-owned models directory: every page would serve and the model download would fail, so
# readiness must say so (src/web/health, storage) and the HEALTHCHECK marks the container unhealthy.
NAME=$ROOT_MODELS
# The placeholder keeps the boot from starting a download it could not write anyway.
volume "$ROOT_MODELS" 0:0 placeholder
start "$NAME" "$DATA" "$ROOT_MODELS"
waited=$SECONDS
until [ "$(curl -s -o "$health" -w '%{http_code}' "$BASE/health/ready")" = 503 ] &&
  [ "$(jq -r '.checks.storage.status' "$health")" = down ]; do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "a root-owned /app/models: the container exited"
  [ $((SECONDS - waited)) -lt $BOOT_TIMEOUT_S ] || fail "a root-owned /app/models: /health/ready never reported storage down within ${BOOT_TIMEOUT_S}s (last: $(cat "$health"))"
  sleep 1
done
fix=$(jq -r '.checks.storage.fix' "$health")
[ "$fix" = "chown -R $APP_UID:$APP_GID the host directory mounted at MODELS_PATH; docs/operations.md#permissions" ] \
  || fail "a root-owned /app/models: storage's fix is '$fix'"
[ "$(jq -r '.checks.database.status' "$health")" = up ] || fail "a root-owned /app/models: the database check is down too"
log "ok: a root-owned /app/models is 503, storage down: $fix"
docker rm -f "$NAME" >/dev/null
# README's quick start, as an owner copies it. The compose project has its own network and volumes, so
# it needs neither the host's Postgres nor the host network; the host port is the only edit besides the
# image and the placeholders (the README's 3000 may be taken here).
log "README quick start"
PROJECT="$SMOKE-readme"
COMPOSE_FILE="$WORK/compose.yml"
awk '/<!-- smoke:quickstart -->/ {on=1} on && /^```yaml$/ {inblock=1; next} inblock && /^```$/ {exit} inblock' \
  "$(dirname "$0")/../README.md" >"$COMPOSE_FILE"
[ -s "$COMPOSE_FILE" ] || fail "README.md has no yaml block after <!-- smoke:quickstart -->"
sed -i.bak \
  -e "s#ghcr.io/kashhq/closet:latest#$IMAGE#" \
  -e "s#'3000:3000'#'$PORT:3000'#" \
  -e "s#<secret>#smoke-test-access-token-secret-not-for-deployment#" \
  -e "s#<password>#smoke-readme-password#" "$COMPOSE_FILE"
grep -qxF "    image: $IMAGE" "$COMPOSE_FILE" \
  || fail "README's closet image line was not replaced by $IMAGE: compose would test the published image"
if grep -v '^ *#' "$COMPOSE_FILE" | grep -q '<[a-z ]*>'; then
  fail "README's compose block has a placeholder the smoke does not fill"
fi
compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }
NAME=$PROJECT-closet-1
readme_cleanup() { compose down -v >/dev/null 2>&1 || true; }
trap 'readme_cleanup; cleanup' EXIT
# Created first so the models volume can hold what a first boot would have downloaded (a placeholder:
# the boot never downloads 940 MB here; with MODELS_DIR the real file).
compose up --no-start >/dev/null 2>&1 || fail "docker compose could not create README's services"
models_volume="${PROJECT}_closet_models"
if [ -n "${MODELS_DIR:-}" ]; then
  docker run --rm --user 0 --entrypoint sh -v "$models_volume:/v" \
    -v "$(cd "$MODELS_DIR" && pwd)/birefnet_512.onnx:/src.onnx:ro" "$IMAGE" \
    -c "cp /src.onnx /v/birefnet_512.onnx && chown -R $APP_UID:$APP_GID /v" >/dev/null
else
  docker run --rm --user 0 --entrypoint sh -v "$models_volume:/v" "$IMAGE" \
    -c "echo 'placeholder: refused on its checksum' >/v/birefnet_512.onnx && chown -R $APP_UID:$APP_GID /v" >/dev/null
fi
wait_ready() {
  local waited=$SECONDS
  until [ "$(curl -s -o "$health" -w '%{http_code}' "$BASE/health/ready")" = 200 ]; do
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "README's closet container exited during boot"
    [ $((SECONDS - waited)) -lt $BOOT_TIMEOUT_S ] || fail "README's closet: /health/ready was not 200 within ${BOOT_TIMEOUT_S}s (last: $(cat "$health"))"
    sleep 1
  done
}
compose up -d >/dev/null 2>&1 || fail "docker compose up of README's block failed"
wait_ready
log "ok: README's compose block reached /health/ready 200"
# `docker compose pull && up -d` recreates the container: the models volume must keep its contents.
docker exec "$NAME" touch /app/models/.recreate-marker || fail "README's closet cannot write /app/models"
compose up -d --force-recreate closet >/dev/null 2>&1 || fail "recreating README's closet failed"
wait_ready
docker exec "$NAME" test -f /app/models/.recreate-marker \
  || fail "a recreated container lost /app/models: README's block does not mount closet_models there"
log "ok: a recreated container finds /app/models as it was (no second model download)"
readme_cleanup

log "PASS $IMAGE in $((SECONDS - started))s"
