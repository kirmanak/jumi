ARG BUN_VERSION=1.2.5

FROM oven/bun:${BUN_VERSION}-alpine AS build

ARG OPENCODE_VERSION=1.15.5
ARG TARGETARCH

RUN apk add --no-cache ca-certificates curl tar
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) platform="linux-x64" ;; \
      arm64) platform="linux-arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${platform}.tar.gz" -o /tmp/opencode.tar.gz; \
    tar -xzf /tmp/opencode.tar.gz -C /tmp; \
    install -m 755 /tmp/opencode /usr/local/bin/opencode

WORKDIR /app/scripts/opencode
COPY scripts/opencode/package.json scripts/opencode/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY scripts/opencode/tsconfig.json ./
COPY scripts/opencode/src ./src
COPY .gitea/opencode-review.json /app/.gitea/opencode-review.json

FROM oven/bun:${BUN_VERSION}-alpine AS runtime

RUN apk add --no-cache ca-certificates
COPY --from=build /usr/local/bin/opencode /usr/local/bin/opencode

WORKDIR /app/scripts/opencode
COPY --from=build /app/scripts/opencode ./
COPY --from=build /app/.gitea /app/.gitea

RUN addgroup -S -g 10001 jumi \
  && adduser -S -G jumi -h /data -u 10001 jumi \
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
