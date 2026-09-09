#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
METADATA="$ROOT_DIR/workers/images/scanner-metadata.json"
IMAGE_PREFIX="${PSKILLS_IMAGE_PREFIX:-private-skills}"
DOCKER_CONTEXT_NAME="${DOCKER_CONTEXT:-}"
TMP_ROOT=""

usage() {
  cat <<'EOF'
Usage: scripts/scanner-acceptance.sh <build|container|native|all> [scanner]

build       Fetch and verify each pinned source, then build image(s).
container   Run the already-built images through DockerExecutor.
native      Fetch/build the scanner engines and run them with TrustedLocalExecutor.
all         Build all images, then run the container acceptance roundtrip.

Set DOCKER_CONTEXT=desktop-linux when the Docker daemon is on that explicit
context. The caller's default Docker context is never changed.
EOF
}

die() {
  echo "scanner-acceptance: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is not installed: $1"
}

metadata() {
  jq -er "$1" "$METADATA"
}

cleanup() {
  if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" && "${PSKILLS_KEEP_ACCEPTANCE:-0}" != 1 ]]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

docker_run() {
  if [[ -n "$DOCKER_CONTEXT_NAME" ]]; then
    docker --context "$DOCKER_CONTEXT_NAME" "$@"
  else
    docker "$@"
  fi
}

validate_context_name() {
  [[ "$DOCKER_CONTEXT_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "DOCKER_CONTEXT contains unsupported characters"
}

fetch_source() {
  local name="$1"
  local repository="$2"
  local revision="$3"
  local checkout="$TMP_ROOT/checkouts/$name"
  mkdir -p "$(dirname -- "$checkout")"
  git init -q "$checkout"
  git -C "$checkout" remote add origin "$repository"
  git -C "$checkout" -c protocol.version=2 fetch --quiet --depth=1 origin "$revision"
  local resolved
  resolved="$(git -C "$checkout" rev-parse FETCH_HEAD)"
  [[ "$resolved" == "$revision" ]] || die "$name source resolved to $resolved, expected $revision"
  git -C "$checkout" checkout --quiet --detach "$revision"
  echo "scanner-acceptance: verified $name source $resolved ($repository)" >&2
  printf '%s\n' "$checkout"
}

archive_source() {
  local checkout="$1"
  local revision="$2"
  local destination="$3"
  rm -rf "$destination"
  mkdir -p "$destination"
  git -C "$checkout" archive "$revision" | tar -x -C "$destination"
}

source_checkout_for() {
  local scanner="$1"
  case "$scanner" in
    cisco)
      fetch_source cisco \
        "$(metadata '.scanners["cisco-skill-scanner"].source')" \
        "$(metadata '.scanners["cisco-skill-scanner"].sourceRevision')"
      ;;
    nvidia)
      fetch_source nvidia \
        "$(metadata '.scanners["nvidia-skillspector"].source')" \
        "$(metadata '.scanners["nvidia-skillspector"].sourceRevision')"
      ;;
    skillsguard)
      fetch_source skillsguard \
        "$(metadata '.scanners.skillsguard.source')" \
        "$(metadata '.scanners.skillsguard.sourceRevision')"
      ;;
    *) die "unknown scanner source: $scanner" ;;
  esac
}

scanner_id_for() {
  case "$1" in
    cisco) printf '%s\n' cisco-skill-scanner ;;
    nvidia) printf '%s\n' nvidia-skillspector ;;
    skillsguard) printf '%s\n' skillsguard ;;
    *) die "unknown scanner: $1" ;;
  esac
}

image_for() {
  local scanner="$1"
  local id
  id="$(scanner_id_for "$scanner")"
  local version
  version="$(metadata ".scanners[\"$id\"].version")"
  case "$scanner" in
    cisco) printf '%s/cisco-skill-scanner:%s\n' "$IMAGE_PREFIX" "$version" ;;
    nvidia) printf '%s/nvidia-skillspector:%s\n' "$IMAGE_PREFIX" "$version" ;;
    skillsguard) printf '%s/skillsguard:%s\n' "$IMAGE_PREFIX" "$version" ;;
    *) die "unknown scanner: $scanner" ;;
  esac
}

stage_context() {
  local scanner="$1"
  local context="$TMP_ROOT/contexts/$scanner"
  local image_dir="$ROOT_DIR/workers/images/$scanner"
  rm -rf "$context"
  mkdir -p "$context"
  cp "$image_dir/Dockerfile" "$image_dir/entrypoint.sh" "$context/"
  if [[ -f "$image_dir/requirements.txt" ]]; then
    cp "$image_dir/requirements.txt" "$context/"
  fi
  case "$scanner" in
    cisco)
      local cisco_source
      cisco_source="$(source_checkout_for cisco)"
      # Cisco's released wheel is installed from the hash-locked PyPI lock;
      # fetching its source revision verifies provenance without enlarging the
      # runtime image with an unused source tree.
      [[ -n "$cisco_source" ]] || die "Cisco source verification returned no checkout"
      ;;
    nvidia)
      local nvidia_source
      nvidia_source="$(source_checkout_for nvidia)"
      archive_source "$nvidia_source" "$(metadata '.scanners["nvidia-skillspector"].sourceRevision')" "$context/source"
      ;;
    skillsguard)
      local skillsguard_source
      skillsguard_source="$(source_checkout_for skillsguard)"
      archive_source "$skillsguard_source" "$(metadata '.scanners.skillsguard.sourceRevision')" "$context/source"
      ;;
  esac
  printf '%s\n' "$context"
}

build_one() {
  local scanner="$1"
  local context
  context="$(stage_context "$scanner")"
  local image
  image="$(image_for "$scanner")"
  docker_run build --pull=false --tag "$image" --file "$context/Dockerfile" "$context"
  echo "scanner-acceptance: built $image" >&2
}

build_images() {
  local selected="${1:-all}"
  case "$selected" in
    all)
      build_one cisco
      build_one nvidia
      build_one skillsguard
      ;;
    cisco|nvidia|skillsguard) build_one "$selected" ;;
    *) die "unknown build target: $selected" ;;
  esac
}

make_docker_command() {
  if [[ -z "$DOCKER_CONTEXT_NAME" ]]; then
    printf '%s\n' docker
    return
  fi
  validate_context_name
  local wrapper="$TMP_ROOT/docker-context"
  printf '%s\n' '#!/bin/sh' 'set -eu' "exec docker --context '$DOCKER_CONTEXT_NAME' \"\$@\"" > "$wrapper"
  chmod 0555 "$wrapper"
  printf '%s\n' "$wrapper"
}

run_container_acceptance() {
  require_command node
  [[ -x "$ROOT_DIR/node_modules/.bin/tsx" ]] || die "JavaScript dependencies are missing; run pnpm install --frozen-lockfile"
  local docker_command
  docker_command="$(make_docker_command)"
  local prefix="$IMAGE_PREFIX"
  PSKILLS_ACCEPTANCE_EXECUTOR=docker \
  PSKILLS_DOCKER_COMMAND="$docker_command" \
  PSKILLS_CISCO_SKILL_SCANNER_COMMAND=skill-scanner \
  PSKILLS_NVIDIA_SKILLSPECTOR_COMMAND=skillspector \
  PSKILLS_SKILLSGUARD_COMMAND=skillsguard \
  PSKILLS_CISCO_SKILL_SCANNER_IMAGE="$prefix/cisco-skill-scanner:$(metadata '.scanners["cisco-skill-scanner"].version')" \
  PSKILLS_NVIDIA_SKILLSPECTOR_IMAGE="$prefix/nvidia-skillspector:$(metadata '.scanners["nvidia-skillspector"].version')" \
  PSKILLS_SKILLSGUARD_IMAGE="$prefix/skillsguard:$(metadata '.scanners.skillsguard.version')" \
  "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/scripts/scanner-acceptance.ts"
}

install_native_cisco() {
  local venv="$TMP_ROOT/venvs/cisco"
  uv venv --python 3.12 "$venv"
  UV_CACHE_DIR="$TMP_ROOT/uv-cache" uv pip install --python "$venv/bin/python" --require-hashes --requirement "$ROOT_DIR/workers/images/cisco/requirements.txt"
  printf '%s\n' "$venv/bin/skill-scanner"
}

install_native_nvidia() {
  local venv="$TMP_ROOT/venvs/nvidia"
  uv venv --python 3.12 "$venv"
  UV_CACHE_DIR="$TMP_ROOT/uv-cache" uv pip install --python "$venv/bin/python" --require-hashes --requirement "$ROOT_DIR/workers/images/nvidia/requirements.txt"
  local checkout
  checkout="$(source_checkout_for nvidia)"
  local source="$TMP_ROOT/native/nvidia-source"
  archive_source "$checkout" "$(metadata '.scanners["nvidia-skillspector"].sourceRevision')" "$source"
  UV_CACHE_DIR="$TMP_ROOT/uv-cache" uv pip install --python "$venv/bin/python" --no-deps --no-build-isolation "$source"
  printf '%s\n' "$venv/bin/skillspector"
}

install_native_skillsguard() {
  local checkout
  checkout="$(source_checkout_for skillsguard)"
  # npm 11 validates the lockfile root name against the project directory
  # basename; keep this directory named skillsguard like package.json.
  local source="$TMP_ROOT/native/skillsguard"
  archive_source "$checkout" "$(metadata '.scanners.skillsguard.sourceRevision')" "$source"
  (cd "$source" && npm ci --ignore-scripts) || die "SkillsGuard npm ci failed"
  (cd "$source" && npm run build) || die "SkillsGuard build failed"
  local wrapper="$TMP_ROOT/native/skillsguard-bin"
  printf '%s\n' '#!/bin/sh' 'set -eu' "exec node '$source/dist/cli.js' \"\$@\"" > "$wrapper"
  chmod 0555 "$wrapper"
  printf '%s\n' "$wrapper"
}

run_native_acceptance() {
  require_command node
  require_command uv
  require_command npm
  [[ -x "$ROOT_DIR/node_modules/.bin/tsx" ]] || die "JavaScript dependencies are missing; run pnpm install --frozen-lockfile"
  local cisco_command nvidia_command skillsguard_command
  cisco_command="$(install_native_cisco)"
  nvidia_command="$(install_native_nvidia)"
  skillsguard_command="$(install_native_skillsguard)"
  PSKILLS_ACCEPTANCE_EXECUTOR=native \
  PSKILLS_CISCO_SKILL_SCANNER_COMMAND="$cisco_command" \
  PSKILLS_NVIDIA_SKILLSPECTOR_COMMAND="$nvidia_command" \
  PSKILLS_SKILLSGUARD_COMMAND="$skillsguard_command" \
  "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/scripts/scanner-acceptance.ts"
}

main() {
  local action="${1:-}"
  local target="${2:-all}"
  [[ -f "$METADATA" ]] || die "scanner metadata is missing: $METADATA"
  require_command git
  require_command jq
  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/private-skills-scanner-acceptance.XXXXXX")"
  case "$action" in
    build)
      require_command docker
      validate_context_name
      build_images "$target"
      ;;
    container)
      require_command docker
      validate_context_name
      run_container_acceptance
      ;;
    native) run_native_acceptance ;;
    all)
      require_command docker
      validate_context_name
      build_images all
      run_container_acceptance
      ;;
    help|-h|--help) usage ;;
    *) usage >&2; exit 64 ;;
  esac
}

main "$@"
