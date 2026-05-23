#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <image-tag> [image-tag...]" >&2
  exit 2
fi

: "${BUN_VERSION:?BUN_VERSION is required}"
: "${OPENCODE_VERSION:?OPENCODE_VERSION is required}"

primary_tag="$1"
shift
extra_tags=("$@")
tools_dir="${RUNNER_TEMP:-/tmp}/jumi-image-tools"
kaniko_root="${RUNNER_TEMP:-/tmp}/jumi-kaniko-root"
docker_config="${RUNNER_TEMP:-/tmp}/jumi-docker-config"
image_tar="${RUNNER_TEMP:-/tmp}/jumi-reviewer-image.tar"
crane_version="${CRANE_VERSION:-0.21.6}"
kaniko_version="${KANIKO_VERSION:-v1.24.0}"

install_dependencies() {
  if command -v proot >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gzip proot tar
    return
  fi

  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache ca-certificates curl gzip proot tar
    return
  fi

  echo "No supported package manager found to install image build dependencies" >&2
  exit 1
}

install_crane() {
  mkdir -p "${tools_dir}"
  if [ -x "${tools_dir}/crane" ]; then
    return
  fi

  case "$(uname -m)" in
    x86_64) crane_arch="Linux_x86_64" ;;
    aarch64 | arm64) crane_arch="Linux_arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  curl -fsSL \
    "https://github.com/google/go-containerregistry/releases/download/v${crane_version}/go-containerregistry_${crane_arch}.tar.gz" \
    | tar -xz -C "${tools_dir}" crane
}

extract_kaniko() {
  if [ -x "${kaniko_root}/kaniko/executor" ]; then
    return
  fi

  rm -rf "${kaniko_root}"
  mkdir -p "${kaniko_root}"
  "${tools_dir}/crane" export "gcr.io/kaniko-project/executor:${kaniko_version}-debug" - \
    | tar -x -C "${kaniko_root}"
}

verify_rootless_user() {
  config_name="$(tar -xOf "${image_tar}" manifest.json | tr ',' '\n' | awk -F'"' '/Config/{print $4; exit}')"
  actual_user="$(tar -xOf "${image_tar}" "${config_name}" | tr ',' '\n' | awk -F'"' '/"User"/{print $4; exit}')"
  if [ "${actual_user}" != "10001:10001" ]; then
    echo "Expected image user 10001:10001, got ${actual_user:-<empty>}" >&2
    exit 1
  fi
}

install_dependencies
install_crane
extract_kaniko
rm -rf "${docker_config}"
mkdir -p "${docker_config}"

kaniko_args=(
  --context=/workspace
  --dockerfile=/workspace/Dockerfile
  --build-arg="BUN_VERSION=${BUN_VERSION}"
  --build-arg="OPENCODE_VERSION=${OPENCODE_VERSION}"
  --destination="${primary_tag}"
  --tar-path="/workspace/.jumi-reviewer-image.tar"
  --ignore-path=/dev
  --ignore-path=/docker-config
  --ignore-path=/kaniko
  --ignore-path=/proc
  --ignore-path=/sys
  --ignore-path=/tmp
  --ignore-path=/workspace
)

for tag in "${extra_tags[@]}"; do
  kaniko_args+=(--destination="${tag}")
done

if [ "${PUSH_IMAGE:-false}" = "true" ]; then
  : "${REGISTRY:?REGISTRY is required when PUSH_IMAGE=true}"
  : "${CONTAINER_REGISTRY_USER:?CONTAINER_REGISTRY_USER is required when PUSH_IMAGE=true}"
  : "${CONTAINER_REGISTRY_PASS:?CONTAINER_REGISTRY_PASS is required when PUSH_IMAGE=true}"
  auth="$(printf '%s:%s' "${CONTAINER_REGISTRY_USER}" "${CONTAINER_REGISTRY_PASS}" | base64 | tr -d '\n')"
  printf '{"auths":{"%s":{"auth":"%s"}}}\n' "${REGISTRY}" "${auth}" > "${docker_config}/config.json"
else
  kaniko_args+=(--no-push)
fi

rm -f .jumi-reviewer-image.tar
DOCKER_CONFIG=/docker-config \
HOME=/workspace \
SSL_CERT_DIR=/kaniko/ssl/certs \
proot \
  -R "${kaniko_root}" \
  -b "${PWD}":/workspace \
  -b /dev:/dev \
  -b /proc:/proc \
  -b /etc/hosts:/etc/hosts \
  -b /etc/resolv.conf:/etc/resolv.conf \
  -b "${docker_config}":/docker-config \
  -w /workspace \
  -0 \
  /kaniko/executor "${kaniko_args[@]}"

if [ ! -f .jumi-reviewer-image.tar ]; then
  echo "Kaniko did not write the expected image tar" >&2
  exit 1
fi

mv .jumi-reviewer-image.tar "${image_tar}"
verify_rootless_user
