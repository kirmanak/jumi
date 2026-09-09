ARG BUN_VERSION=1.2.5
ARG HELM_VERSION=3.18.6
ARG TEMURIN_TAG=21.0.12_8-jdk

# oven/bun:1.2.5-slim is bullseye; bullseye-security InRelease expires / 404s
# (image-build 2026-09-05 libperl, 2026-09-08 Valid-Until). Fetch tools and
# install git on bookworm; copy bun from the slim image.
FROM debian:bookworm-slim AS tools

ARG OPENCODE_VERSION=1.15.5
ARG HELM_VERSION=3.18.6
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) platform="linux-x64" ;; \
      arm64) platform="linux-arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${platform}.tar.gz" -o "${tmp_dir}/opencode.tar.gz"; \
    tar -xzf "${tmp_dir}/opencode.tar.gz" -C "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/opencode" /usr/local/bin/opencode; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) helm_arch="amd64" ;; \
      arm64) helm_arch="arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${helm_arch}.tar.gz" -o "${tmp_dir}/helm.tar.gz"; \
    tar -xzf "${tmp_dir}/helm.tar.gz" -C "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/linux-${helm_arch}/helm" /usr/local/bin/helm; \
    rm -rf "${tmp_dir}"

FROM oven/bun:${BUN_VERSION}-slim AS build

WORKDIR /app/scripts/opencode
COPY scripts/opencode/package.json scripts/opencode/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY scripts/opencode/tsconfig.json ./
COPY scripts/opencode/src ./src
COPY .gitea/opencode-review.json /app/.gitea/opencode-review.json
COPY .gitea/opencode-implement.json /app/.gitea/opencode-implement.json

FROM debian:bookworm-slim AS runtime

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.source="https://gitea.kirmanak.stream/personal/jumi" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep jq file findutils libstdc++6 python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tools /usr/local/bin/opencode /usr/local/bin/opencode
COPY --from=tools /usr/local/bin/helm /usr/local/bin/helm
RUN git --version \
  && rg --version \
  && jq --version \
  && file --version \
  && python3 --version \
  && helm version --short \
  && bun --version \
  && /usr/local/bin/opencode version

WORKDIR /app/scripts/opencode
COPY --from=build /app/scripts/opencode ./
COPY --from=build /app/.gitea /app/.gitea
COPY review-skills /app/review-skills
COPY scripts/opencode/entrypoint.sh /app/scripts/opencode/entrypoint.sh
RUN chmod 755 /app/scripts/opencode/entrypoint.sh

RUN groupadd --gid 10001 jumi \
  && useradd --uid 10001 --gid 10001 --home-dir /data --create-home --shell /usr/sbin/nologin jumi \
  && mkdir -p /data /work \
  && chown -R jumi:jumi /data /work

USER 10001:10001

ENV HOME=/data \
    WORKDIR=/work \
    HOST=0.0.0.0 \
    PORT=3000 \
    OPENCODE_CONFIG=/app/.gitea/opencode-review.json \
    OPENCODE_MODEL=openai/gpt-5.5

EXPOSE 3000
ENTRYPOINT ["/app/scripts/opencode/entrypoint.sh"]
CMD ["bun", "run", "src/server.ts"]

ARG TEMURIN_TAG
FROM eclipse-temurin:${TEMURIN_TAG} AS jdk

FROM runtime AS worker
USER root
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY .gitea/opencode-implement.json /app/.gitea/opencode-implement.json
USER 10001:10001
ENV JAVA_HOME=/opt/java/openjdk \
    OPENCODE_CONFIG=/app/.gitea/opencode-implement.json \
    AGENT_INSTANCE=jumi-worker
ENV PATH="${JAVA_HOME}/bin:${PATH}"
CMD ["bun", "run", "src/worker_server.ts"]
