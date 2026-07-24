ARG BUN_VERSION=1.2.5

FROM oven/bun:${BUN_VERSION}-slim AS build

ARG OPENCODE_VERSION=1.15.5
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

WORKDIR /app/scripts/opencode
COPY scripts/opencode/package.json scripts/opencode/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY scripts/opencode/tsconfig.json ./
COPY scripts/opencode/src ./src
COPY .gitea/opencode-review.json /app/.gitea/opencode-review.json

FROM oven/bun:${BUN_VERSION}-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep jq file findutils \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/opencode /usr/local/bin/opencode
RUN git --version \
  && rg --version \
  && jq --version \
  && file --version \
  && /usr/local/bin/opencode version

WORKDIR /app/scripts/opencode
COPY --from=build /app/scripts/opencode ./
COPY --from=build /app/.gitea /app/.gitea

RUN groupadd --gid 10001 jumi \
  && useradd --uid 10001 --gid 10001 --home-dir /data --create-home --shell /usr/sbin/nologin jumi \
  && mkdir -p /data /work \
  && chown -R jumi:jumi /app /data /work

USER 10001:10001

ENV HOME=/data \
    WORKDIR=/work \
    HOST=0.0.0.0 \
    PORT=3000 \
    OPENCODE_CONFIG=/app/.gitea/opencode-review.json \
    OPENCODE_MODEL=openai/gpt-5.5

EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
