# jumi

Self-hosted Gitea PR review automation for the [`kirmanak`](https://gitea.kirmanak.stream/kirmanak) organization.

## Reviewer Service

`jumi-reviewer` is a long-running webhook service. Gitea sends pull request webhooks to the service, the service verifies the webhook, runs OpenCode with persisted ChatGPT/OpenAI auth, posts a commit status on the PR head SHA, and posts or updates one sticky PR review comment.

Flow:

```text
Gitea org webhook
  -> Traefik HTTPS ingress
  -> jumi-reviewer /webhooks/gitea
  -> signature/org validation
  -> single-worker review queue
  -> OpenCode review
  -> commit status + sticky Gitea PR comment
```

The service intentionally does not checkout or execute PR-head code. It reviews Gitea's PR metadata and file patches from the trusted Gitea API.

## Image

The image workflow publishes:

```text
gitea.kirmanak.stream/personal/jumi-reviewer:<commit-sha>
gitea.kirmanak.stream/personal/jumi-reviewer:latest
```

Required repository secrets for `.gitea/workflows/jumi-reviewer-image.yml`:

| Name | Description |
|------|-------------|
| `CONTAINER_REGISTRY_PASS` | Gitea token or password with package write access |

Required repository variables:

| Name | Description |
|------|-------------|
| `CONTAINER_REGISTRY_USER` | Gitea user that can push packages for `personal` |

Pull requests run the same lint/typecheck/test gate and build the image without publishing it.

## Runtime Configuration

Required environment variables:

| Name | Description |
|------|-------------|
| `GITEA_URL` | Trusted Gitea base URL, e.g. `https://gitea.kirmanak.stream` |
| `GITEA_BOT_TOKEN` | Bot token used by the service to fetch PR data and post comments |
| `GITEA_WEBHOOK_SECRET` | Secret used to verify `X-Gitea-Signature` |

Optional environment variables:

| Name | Default | Description |
|------|---------|-------------|
| `HOST` | `0.0.0.0` | HTTP bind host |
| `PORT` | `3000` | HTTP bind port |
| `GITEA_WEBHOOK_AUTH_TOKEN` | unset | Optional exact or bearer `Authorization` header value |
| `GITEA_ALLOWED_ORGS` | `kirmanak` | Comma-separated allowed orgs |
| `GITEA_ALLOWED_REPOS` | unset | Optional comma-separated `owner/repo` allowlist |
| `BOT_USERNAME` | `jumi` | Bot login used to find the sticky comment |
| `OPENCODE_MODEL` | `openai/gpt-5.5` | OpenCode model ID passed to `opencode run -m`; shared provider/small-model defaults come from the remote `.well-known/opencode` config |
| `OPENCODE_CONFIG` | `/app/.gitea/opencode-review.json` in the image | Hardened reviewer-specific OpenCode permission config path |
| `OPENCODE_WELLKNOWN_URL` | `https://kirmanak.stream` | Remote OpenCode config origin. The service seeds a `wellknown` auth entry so OpenCode loads `/.well-known/opencode` before the local review policy. |
| `OPENCODE_WELLKNOWN_KEY` | `OPENCODE_WELLKNOWN_TOKEN` | Logical key name recorded in OpenCode auth for the well-known provider |
| `OPENCODE_WELLKNOWN_TOKEN` | `unused` | Token placeholder for the public well-known config entry |
| `HOME` | `/data` in the image | OpenCode auth storage root |
| `WORKDIR` | `/work` in the image | Temporary review workspace root |
| `QUEUE_CONCURRENCY` | `1` | Review worker concurrency |
| `MAX_FILES` | `100` | Max changed files sent to OpenCode |
| `MAX_PATCH_BYTES` | `500000` | Max patch bytes sent to OpenCode |
| `MAX_OUTPUT_BYTES` | `80000` | Max OpenCode output bytes posted back |
| `MAX_WEBHOOK_BYTES` | `1048576` | Max accepted webhook payload bytes |
| `OPENCODE_TIMEOUT_MS` | `900000` | OpenCode run timeout |

## OpenCode Auth

Mount a persistent volume at `/data` and seed OpenCode auth at:

```text
/data/.local/share/opencode/auth.json
```

Use an existing `opencode /connect` login from this machine or run `opencode /connect` with `HOME=/data` during setup. The service relies on the persisted OAuth refresh/access state, not provider API keys in env vars.

On startup, Jumi also preserves the existing auth file and adds this entry when it is missing:

```json
{
  "https://kirmanak.stream": {
    "type": "wellknown",
    "key": "OPENCODE_WELLKNOWN_TOKEN",
    "token": "unused"
  }
}
```

That makes OpenCode load shared defaults from `https://kirmanak.stream/.well-known/opencode` before this repository's local review policy, without requiring deployment-specific init-container wiring.

The service runs OpenCode with a sanitized environment. Gitea tokens and webhook secrets are not passed to the OpenCode child process.
The container runtime process runs as non-root UID/GID `10001:10001`.

## Webhook Setup

Create one Gitea organization webhook for `kirmanak`:

| Setting | Value |
|---------|-------|
| Target URL | `https://<traefik-host>/webhooks/gitea` |
| HTTP Method | `POST` |
| POST Content Type | `application/json` |
| Secret | Same value as `GITEA_WEBHOOK_SECRET` |
| Trigger On | Pull request events |
| Active | Checked |

The service processes `opened`, `reopened`, and new-commit synchronization actions only; PR description edits are acknowledged and skipped.

The service also exposes:

```text
GET /healthz
```

## Security Model

The service rejects requests that fail any of these checks:

| Check | Enforcement |
|-------|-------------|
| Method/path | Only `POST /webhooks/gitea` is accepted |
| Content type | Must include `application/json` |
| Signature | `X-Gitea-Signature` must match the raw body HMAC-SHA256 |
| Event | Only `X-Gitea-Event: pull_request` is processed |
| Origin | Repository URLs must match `GITEA_URL` origin |
| Scope | Repository owner must be in `GITEA_ALLOWED_ORGS` |
| Repo allowlist | `GITEA_ALLOWED_REPOS` is enforced when set |

OpenCode permissions are locked down in `.gitea/opencode-review.json`: file edits, external directory access, tasks, questions, skills, and LSP are denied. Documentation lookup is allowed through OpenCode web fetch/search tools. Bash is denied by default, with an allowlist for read-only Git inspection commands plus explicit deny rules for known mutation, command-execution, file-write, and shell-metacharacter escape hatches.

## Local Development

Install dependencies and run the local CI checks:

```bash
cd scripts/opencode
bun install --frozen-lockfile
bun run ci
```

Run the service locally:

```bash
GITEA_URL=https://gitea.kirmanak.stream \
GITEA_BOT_TOKEN=... \
GITEA_WEBHOOK_SECRET=... \
OPENCODE_CONFIG=$PWD/../../.gitea/opencode-review.json \
HOME=/path/to/persisted/opencode-home \
WORKDIR=/tmp/jumi-reviewer \
bun run server
```

## Structure

```text
.gitea/
  opencode-review.json       # Hardened review-only OpenCode config
  tool-versions.env          # Pinned OpenCode/Bun versions
  workflows/
    opencode-checks.yml      # PR lint/typecheck/test and image build checks
    jumi-reviewer-image.yml  # Image build/push workflow
scripts/
  opencode/
    src/                     # Bun/TypeScript webhook and review service
Dockerfile
renovate.json
```
