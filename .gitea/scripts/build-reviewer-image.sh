#!/usr/bin/env bash
# Build jumi-reviewer with Buildah on GARM (ubuntu-latest).
# Env: BUN_VERSION, OPENCODE_VERSION required.
#      PUSH_IMAGE=true enables registry push (needs REGISTRY + CONTAINER_REGISTRY_*).
# Isolation defaults: BUILDAH_ISOLATION=chroot, STORAGE_DRIVER=vfs (no --layers).
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <image-tag> [image-tag...]" >&2
  exit 2
fi

: "${BUN_VERSION:?BUN_VERSION is required}"
: "${OPENCODE_VERSION:?OPENCODE_VERSION is required}"
: "${HELM_VERSION:?HELM_VERSION is required}"

primary_tag="$1"
shift
extra_tags=("$@")

VERSION="${VERSION:-dev}"
REVISION="${REVISION:-${COMMIT_SHA:-unknown}}"

export BUILDAH_ISOLATION="${BUILDAH_ISOLATION:-chroot}"
export STORAGE_DRIVER="${STORAGE_DRIVER:-vfs}"

if ! command -v buildah >/dev/null 2>&1; then
  echo "buildah not found on PATH (expected on garm-act-runner / ubuntu-latest)" >&2
  exit 1
fi

buildah --version
buildah info

# No --layers: vfs full-copies the tree per layer and can fill ephemeral runner disk.
# Multi-tag via repeated -t; push is gated separately.
tag_args=(-t "${primary_tag}")
for tag in "${extra_tags[@]}"; do
  tag_args+=(-t "${tag}")
done

buildah bud \
  --format docker \
  --target runtime \
  "${tag_args[@]}" \
  --build-arg "BUN_VERSION=${BUN_VERSION}" \
  --build-arg "OPENCODE_VERSION=${OPENCODE_VERSION}" \
  --build-arg "HELM_VERSION=${HELM_VERSION}" \
  --build-arg "VERSION=${VERSION}" \
  --build-arg "REVISION=${REVISION}" \
  -f Dockerfile \
  .

verify_rootless_user() {
  local actual_user
  # Prefer config.user; fall back to OCIv1 User field shapes.
  actual_user="$(
    buildah inspect --type image --format '{{.Docker.Config.User}}' "${primary_tag}" 2>/dev/null \
      || true
  )"
  if [ -z "${actual_user}" ] || [ "${actual_user}" = "<no value>" ]; then
    actual_user="$(
      buildah inspect --type image --format '{{.OCIv1.Config.User}}' "${primary_tag}" 2>/dev/null \
        || true
    )"
  fi
  if [ "${actual_user}" != "10001:10001" ]; then
    echo "Expected image user 10001:10001, got ${actual_user:-<empty>}" >&2
    exit 1
  fi
  echo "Verified image user: ${actual_user}"
}

verify_rootless_user

verify_reviewer_runtime() {
  local ctr config_json
  ctr="$(buildah from "${primary_tag}")"
  if ! buildah run "${ctr}" -- python3 --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "python3 missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- helm version --short; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "helm missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- test -f /app/review-skills/gitops-apply-review/SKILL.md; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "gitops-apply-review skill missing in reviewer image" >&2
    exit 1
  fi
  if ! config_json="$(
    buildah run \
      --env OPENCODE_DISABLE_PROJECT_CONFIG=1 \
      --env OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
      "${ctr}" -- \
      timeout 120 sh -c 'cd /work && git init -q && opencode debug config'
  )"; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "opencode debug config failed" >&2
    exit 1
  fi
  if ! printf '%s\n' "${config_json}" | grep -F '/app/review-skills' >/dev/null; then
    printf '%s\n' "${config_json}" >&2
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "opencode debug config did not load skills.paths /app/review-skills" >&2
    exit 1
  fi
  echo "Verified python3, helm, gitops-apply-review skill, and opencode debug config"
  buildah rm "${ctr}" >/dev/null
}

verify_reviewer_runtime

if [ "${PUSH_IMAGE:-false}" = "true" ]; then
  : "${REGISTRY:?REGISTRY is required when PUSH_IMAGE=true}"
  : "${CONTAINER_REGISTRY_USER:?CONTAINER_REGISTRY_USER is required when PUSH_IMAGE=true}"
  : "${CONTAINER_REGISTRY_PASS:?CONTAINER_REGISTRY_PASS is required when PUSH_IMAGE=true}"

  # Never put the password on argv (visible in /proc/*/cmdline).
  printf '%s\n' "${CONTAINER_REGISTRY_PASS}" | buildah login \
    -u "${CONTAINER_REGISTRY_USER}" \
    --password-stdin \
    "${REGISTRY}"

  all_tags=("${primary_tag}" "${extra_tags[@]}")
  for tag in "${all_tags[@]}"; do
    buildah push "${tag}" "docker://${tag}"
  done

  buildah logout "${REGISTRY}"
fi
