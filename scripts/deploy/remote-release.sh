#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage: remote-release.sh --release-dir PATH --stage-dir PATH --revision SHA \
  --controller-image IMAGE --gateway-image IMAGE \
  --controller-archive PATH --gateway-archive PATH --checksums PATH \
  --compose-overlay PATH [--env-file PATH]

Load two verified linux/amd64 images and switch the existing production Compose
services to them. The command keeps the previous release env for best-effort
rollback when the new containers fail their health checks.
EOF
}

die() {
  printf '[release] ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[release] %s\n' "$*"
}

release_dir=''
stage_dir=''
revision=''
controller_image=''
gateway_image=''
controller_archive=''
gateway_archive=''
checksums=''
compose_overlay=''
env_file='.runtime/controller.env'

while (($#)); do
  case "$1" in
    --release-dir|-r) [[ $# -ge 2 ]] || die "$1 requires a value"; release_dir=$2; shift 2 ;;
    --stage-dir|-s) [[ $# -ge 2 ]] || die "$1 requires a value"; stage_dir=$2; shift 2 ;;
    --revision|-v) [[ $# -ge 2 ]] || die "$1 requires a value"; revision=$2; shift 2 ;;
    --controller-image|-c) [[ $# -ge 2 ]] || die "$1 requires a value"; controller_image=$2; shift 2 ;;
    --gateway-image|-g) [[ $# -ge 2 ]] || die "$1 requires a value"; gateway_image=$2; shift 2 ;;
    --controller-archive|-C) [[ $# -ge 2 ]] || die "$1 requires a value"; controller_archive=$2; shift 2 ;;
    --gateway-archive|-G) [[ $# -ge 2 ]] || die "$1 requires a value"; gateway_archive=$2; shift 2 ;;
    --checksums|-k) [[ $# -ge 2 ]] || die "$1 requires a value"; checksums=$2; shift 2 ;;
    --compose-overlay|-o) [[ $# -ge 2 ]] || die "$1 requires a value"; compose_overlay=$2; shift 2 ;;
    --env-file|-e) [[ $# -ge 2 ]] || die "$1 requires a value"; env_file=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    --) shift; (($# == 0)) || die "unexpected arguments: $*" ;;
    *) die "unknown option: $1 (use --help)" ;;
  esac
done

for required in release_dir stage_dir revision controller_image gateway_image \
  controller_archive gateway_archive checksums compose_overlay; do
  [[ -n ${!required} ]] || die "missing --${required//_/-}"
done

[[ $revision =~ ^[0-9a-f]{40}$ ]] || die 'revision must be a full lowercase commit SHA'
[[ $controller_image =~ ^[a-z0-9./_-]+:[0-9a-f]{40}$ ]] || die 'controller image must be tagged with the revision'
[[ $gateway_image =~ ^[a-z0-9./_-]+:[0-9a-f]{40}$ ]] || die 'gateway image must be tagged with the revision'
[[ $controller_image == *:"$revision" ]] || die 'controller image tag does not match revision'
[[ $gateway_image == *:"$revision" ]] || die 'gateway image tag does not match revision'
[[ -d $release_dir ]] || die "release directory does not exist: $release_dir"
[[ -d $stage_dir ]] || die "stage directory does not exist: $stage_dir"

case "$env_file" in
  /*) controller_env=$env_file ;;
  *) controller_env=$release_dir/$env_file ;;
esac
[[ -f $controller_env ]] || die "controller env file does not exist: $controller_env"
[[ -f $release_dir/compose.yaml ]] || die 'base Compose file is missing from the release directory'
[[ -f $release_dir/deploy/compose.production.yaml ]] || die 'production Compose overlay is missing'
[[ -f $release_dir/deploy/compose.gateway.yaml ]] || die 'Gateway Compose overlay is missing'
[[ -f $release_dir/deploy/security/codex-seccomp.json ]] || die 'seccomp policy is missing'
[[ -f $controller_archive && -f $gateway_archive && -f $checksums && -f $compose_overlay ]] || die 'release bundle is incomplete'

if command -v stat >/dev/null 2>&1; then
  env_mode=$(stat -c '%a' "$controller_env" 2>/dev/null || stat -f '%Lp' "$controller_env")
  if (( (8#$env_mode & 077) != 0 )); then
    die "controller env file must not be group/world readable: $controller_env"
  fi
fi

command -v docker >/dev/null 2>&1 || die 'docker is not installed'
if ! docker version >/dev/null 2>&1; then
  die 'Docker daemon preflight failed'
fi
if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  compose=(docker-compose)
else
  die 'Docker Compose is unavailable'
fi

compose_with_env() {
  local release_env_path=$1
  shift
  local args=(--env-file "$controller_env" --env-file "$release_env_path" --project-directory "$release_dir"
    --profile wechat -f "$release_dir/compose.yaml" -f "$release_dir/deploy/compose.production.yaml"
    -f "$release_dir/deploy/compose.gateway.yaml" -f "$compose_overlay")
  env -u COMPOSE_FILE -u COMPOSE_PROFILES -u COMPOSE_ENV_FILES -u COMPOSE_PROJECT_NAME \
    "${compose[@]}" "${args[@]}" "$@"
}

release_env=$release_dir/.runtime/release.env
release_env_next=$stage_dir/release.env.next
release_env_previous=$release_env.previous
had_previous=0
previous_controller_image=''
previous_gateway_image=''
umask 077
printf 'CONTROLLER_IMAGE=%s\nGATEWAY_IMAGE=%s\n' "$controller_image" "$gateway_image" > "$release_env_next"
chmod 600 "$release_env_next"

cleanup() {
  rm -f -- "$controller_archive" "$gateway_archive" "$checksums" "$compose_overlay" "$stage_dir/manifest.env" \
    "$stage_dir/remote-release.sh" "$release_env_next"
  rmdir "$stage_dir" 2>/dev/null || true
}
trap cleanup EXIT

log 'read-only Compose preflight'
if ! compose_with_env "$release_env_next" config --quiet; then
  die 'read-only Compose preflight failed'
fi
checksums_dir=${checksums%/*}
[[ $checksums_dir == "$checksums" ]] && checksums_dir=.
if ! (cd "$checksums_dir" && sha256sum -c "${checksums##*/}"); then
  die 'release archive checksum verification failed'
fi

inspect_image() {
  local image=$1 expected=$2 component=$3
  local platform image_revision
  platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
  image_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  [[ $platform == 'linux/amd64' ]] || die "$component image platform is $platform, expected linux/amd64"
  [[ $image_revision == "$expected" ]] || die "$component image revision is $image_revision, expected $expected"
  printf '%s image=%s platform=%s revision=%s\n' "$component" "$image" "$platform" "$image_revision"
}

log 'loading verified image archives'
if ! docker load --input "$controller_archive" >/dev/null; then
  die 'Controller image archive could not be loaded'
fi
if ! docker load --input "$gateway_archive" >/dev/null; then
  die 'Gateway image archive could not be loaded'
fi
inspect_image "$controller_image" "$revision" controller
inspect_image "$gateway_image" "$revision" gateway

rollback() {
  (( had_previous == 1 )) || { log 'no previous release env; rollback is unavailable'; return 0; }
  log 'restoring the previous image selection after a failed health check'
  mv -f "$release_env_previous" "$release_env"
  if ! compose_with_env "$release_env" up -d --no-build controller gateway >/dev/null; then
    log 'previous containers could not be restarted; manual intervention is required'
    return 1
  fi
  return 0
}

wait_healthy() {
  local service=$1
  local timeout_seconds=${2:-180}
  local deadline=$(( $(date +%s) + timeout_seconds ))
  local container state health
  while (( $(date +%s) < deadline )); do
    container=$(compose_with_env "$release_env" ps -q "$service" 2>/dev/null || true)
    if [[ -n $container ]]; then
      state=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)
      if [[ $state == running && $health == healthy ]]; then
        return 0
      fi
      if [[ $state == exited || $state == dead || $health == unhealthy ]]; then
        log "$service stopped before becoming healthy (state=$state health=$health)"
        return 1
      fi
    fi
    sleep 5
  done
  log "$service did not become healthy within ${timeout_seconds}s"
  return 1
}

log 'validating the staged Compose configuration with immutable image names'
if ! compose_with_env "$release_env_next" config --quiet; then
  die 'staged Compose configuration failed before activation'
fi
if [[ -f $release_env ]]; then
  cp -p "$release_env" "$release_env_previous"
  had_previous=1
  previous_controller_image=$(sed -n 's/^CONTROLLER_IMAGE=//p' "$release_env_previous")
  previous_gateway_image=$(sed -n 's/^GATEWAY_IMAGE=//p' "$release_env_previous")
fi
mkdir -p "${release_env%/*}"
mv -f "$release_env_next" "$release_env"

log "recreating controller and gateway for revision $revision"
if ! compose_with_env "$release_env" up -d --no-build --force-recreate controller gateway >/dev/null; then
  rollback || true
  die 'Compose stopped before the new release started'
fi

if ! wait_healthy controller || ! wait_healthy gateway; then
  rollback || true
  die 'new containers failed health verification; deployment is not successful'
fi

verify_runtime() {
  local service container state health image image_revision
  for service in controller gateway; do
    container=$(compose_with_env "$release_env" ps -q "$service")
    state=$(docker inspect --format '{{.State.Status}}' "$container")
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
    image=$(docker inspect --format '{{.Config.Image}}' "$container")
    image_revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")
    [[ $state == running && $health == healthy && $image_revision == "$revision" ]] || return 1
    printf 'service=%s container=%s state=%s health=%s image=%s revision=%s\n' \
      "$service" "$container" "$state" "$health" "$image" "$image_revision"
  done
}

if ! verify_runtime; then
  rollback || true
  die 'runtime verification failed; deployment is not successful'
fi

prune_old_images() {
  local repository image removed=0
  for repository in super-leader-controller super-leader-gateway; do
    while IFS= read -r image; do
      [[ -n $image ]] || continue
      if [[ $image == "$controller_image" || $image == "$gateway_image" ||
        $image == "$previous_controller_image" || $image == "$previous_gateway_image" ]]; then
        continue
      fi
      if docker image rm "$image" >/dev/null 2>&1; then
        ((removed += 1))
      fi
    done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' --filter "reference=$repository:*")
  done
  log "pruned $removed superseded release image tag(s); current and previous remain available"
}

prune_old_images
log "deployment verified for revision $revision"
