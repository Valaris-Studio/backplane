#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$#" -le 1 ]] || { echo "Usage: $0 [linux/amd64|linux/arm64]" >&2; exit 2; }
PLATFORM="${1:-}"
if [[ -z "$PLATFORM" ]]; then
  case "$(uname -m)" in
    x86_64) PLATFORM=linux/amd64 ;;
    arm64|aarch64) PLATFORM=linux/arm64 ;;
    *) echo 'Pass a supported runner container platform explicitly.' >&2; exit 2 ;;
  esac
fi
case "$PLATFORM" in
  linux/amd64|linux/arm64) ;;
  *) echo "Unsupported runner container platform: $PLATFORM" >&2; exit 2 ;;
esac
command -v docker >/dev/null || { echo 'Runner container gate requires Docker.' >&2; exit 1; }
command -v timeout >/dev/null || { echo 'Runner container gate requires GNU timeout.' >&2; exit 1; }

GATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/backplane-runner-container.XXXXXXXX")"
GATE_TOKEN="$(basename "$GATE_DIR" | tr '[:upper:]' '[:lower:]')"
GATE_TOKEN="${GATE_TOKEN//./-}"
IMAGE_TAG="backplane-runner-container-gate:$GATE_TOKEN"
CONTAINER_NAME="$GATE_TOKEN"
OWNER_LABEL=io.backplane.runner-container-gate

docker_read() {
  timeout --kill-after=5s 20s docker "$@"
}

cleanup_container() {
  local container_id owner remaining
  container_id="$(docker_read container ls --all --quiet --no-trunc --filter "name=^/${CONTAINER_NAME}$")" || return 1
  [[ -n "$container_id" ]] || return 0
  [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
  owner="$(docker_read container inspect --format "{{index .Config.Labels \"$OWNER_LABEL\"}}" "$container_id")" || return 1
  [[ "$owner" == "$GATE_TOKEN" ]] || return 1
  docker_read container rm --force "$container_id" || return 1
  remaining="$(docker_read container ls --all --quiet --no-trunc --filter "id=$container_id")" || return 1
  [[ -z "$remaining" ]]
}

cleanup_image() {
  local image_id owner remaining
  image_id="$(docker_read image ls --quiet --no-trunc --filter "reference=$IMAGE_TAG")" || return 1
  if [[ -n "$image_id" ]]; then
    [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    owner="$(docker_read image inspect --format "{{index .Config.Labels \"$OWNER_LABEL\"}}" "$image_id")" || return 1
    [[ "$owner" == "$GATE_TOKEN" ]] || return 1
    docker_read image rm "$IMAGE_TAG" || return 1
  fi
  remaining="$(docker_read image ls --all --quiet --no-trunc --filter "label=$OWNER_LABEL=$GATE_TOKEN")" || return 1
  [[ -z "$remaining" ]]
}

cleanup() {
  local result=$? cleanup_failed=0
  trap - EXIT INT TERM
  if ! cleanup_container; then
    echo "Runner container cleanup failed: $CONTAINER_NAME" >&2
    cleanup_failed=1
  fi
  if ! cleanup_image; then
    echo "Runner image cleanup failed: $IMAGE_TAG" >&2
    cleanup_failed=1
  fi
  rm -rf -- "$GATE_DIR" || cleanup_failed=1
  if [[ "$result" -eq 0 && "$cleanup_failed" -ne 0 ]]; then result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Refuse a collision before creating resources; cleanup also checks ownership.
EXISTING_CONTAINER="$(docker_read container ls --all --quiet --filter "name=^/${CONTAINER_NAME}$")"
[[ -z "$EXISTING_CONTAINER" ]]
EXISTING_IMAGE="$(docker_read image ls --quiet --filter "reference=$IMAGE_TAG")"
[[ -z "$EXISTING_IMAGE" ]]

printf 'Runner container gate: %s (%s)\n' "$PLATFORM" "$GATE_TOKEN"
timeout --kill-after=10s 1200s docker build --load --progress plain \
  --platform "$PLATFORM" --build-arg 'CODING_AGENTS=claude codex' \
  --label "$OWNER_LABEL=$GATE_TOKEN" --iidfile "$GATE_DIR/image-id" \
  --tag "$IMAGE_TAG" "$ROOT/runner"
IMAGE_ID="$(cat "$GATE_DIR/image-id")"
[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$(docker_read image inspect --format '{{.Id}}' "$IMAGE_TAG")" == "$IMAGE_ID" ]]
[[ "$(docker_read image inspect --format "{{index .Config.Labels \"$OWNER_LABEL\"}}" "$IMAGE_ID")" == "$GATE_TOKEN" ]]

timeout --kill-after=10s 120s docker run --name "$CONTAINER_NAME" \
  --label "$OWNER_LABEL=$GATE_TOKEN" --platform "$PLATFORM" --network none -i \
  --entrypoint /bin/sh "$IMAGE_ID" -s -- claude codex \
  < "$ROOT/runner/scripts/test-container-runtime.sh"
