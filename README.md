# jumi

Self-hosted Gitea PR review automation. Owner scope is `GITEA_ALLOWED_ORGS` (`*` = every owner on the instance).

## Reviewer Service

`jumi-reviewer` is a long-running webhook service. Gitea sends pull request webhooks to the service, the service verifies the webhook, runs OpenCode with persisted ChatGPT/OpenAI auth, posts a commit status on the PR head SHA, and posts or updates one sticky PR review comment.

Flow:

```text
Gitea org/user/system webhook
  -> Traefik HTTPS ingress
  -> jumi-reviewer /webhooks/gitea
  -> signature/org validation
  -> single-worker review queue
  -> OpenCode review
  -> commit status + sticky Gitea PR comment
```

The service posts `jumi/opencode-review` on the PR head SHA from an explicit trailer in the OpenCode output (`<!-- jumi-check: success -->` or `<!-- jumi-check: failure -->`), not by grepping 🔴/🟡 in the prose:

- `pending` while the review is running
- `success` / `failure` from that trailer (❓ may still be `success`)
- `failure` if OpenCode crashes, returns empty output, or omits the trailer
- `warning` when a queued job is skipped after it already went pending (for example the PR head changed)

The trailer is stripped from the sticky comment. Title-gated skips (`WIP:`, `[skip review]`) still post no status.

The service intentionally does not checkout or execute PR-head code. It reviews Gitea's PR metadata and file patches from the trusted Gitea API.

## Worker Service

`jumi-worker` is a sibling HTTP service in the same Bun package. Gitea sends **Issues** webhooks (and follow-up review events) to `POST /webhooks/gitea`. The worker verifies `X-Gitea-Signature` the same way as the reviewer, then enqueues work only when the issue is assigned to bot username `jumi` (`BOT_USERNAME`, default `jumi`). Pull-request issues (`issue.pull_request` present / non-null) are ignored for first-run implement. Org-hook checkboxes and GitOps IngressRoutes are not configured in this repo.

Gitea 1.27 delivers assignment as a grouped issue event, not a GitHub-style top-level `assignee` field:

- Headers: `X-Gitea-Event: issues` and `X-Gitea-Event-Type: issue_assign` (also `X-GitHub-Event` / `X-GitHub-Event-Type`).
- Body: `IssuePayload` with `action`, `number`, `issue`, `repository`, `sender` (`modules/structs/hook.go`). `issue.assignee` / `issue.assignees` are `User` objects with `login` (and compat `username`).
- Actions: `issues` → `opened`/`closed`/`reopened`/`edited`/`deleted`; `issue_assign` → `assigned`/`unassigned`.
- The org/system hook must enable **both** `Issues` and `Issue Assign` (separate Gitea checkboxes). `Issues` alone will not fire on assign.

Webhook handling:

- `X-Gitea-Event: issues` or `issue_assign` with action `assigned`, `opened`, or `reopened` (and assigned to the bot) → enqueue first-run implement
- `unassigned` when the bot is no longer an assignee → cancel: kill a live child, comment `stopped`, delete the claim and follow-up state files
- `unassigned` when the bot remains among multiple assignees → no cancel
- `X-Gitea-Event: issue_comment` / `pull_request_comment` with action `created` on an open jumi closing PR (human sender, non-empty body, not a jumi sticky) → enqueue follow-up keyed by the closed issue
- `X-Gitea-Event: pull_request_rejected` on an open jumi closing PR → enqueue follow-up
- `X-Gitea-Event: pull_request` → `202` skip (reviewer only)
- `X-Gitea-Event: ping` → `200 {"ok":true}`
- other events → `202` skip

Skip follow-up when the sender is `jumi`, the comment was `edited`/`deleted`, the body is empty or contains `<!-- jumi-worker:` / `<!-- jumi-check:`, the PR is a fork/draft/`WIP:`, or the closing issue is not assigned to the bot.

On enqueue the parent claims the issue with a PID/heartbeat file under `{HOME}/worker/jobs/{owner}/{repo}/{number}.json`. A claim is live only while that PID is alive **and** the heartbeat is newer than two minutes. The parent clones a bare cache and worktree from the default branch, writes `JUMI_TASK.md`, and runs `opencode run` with `.gitea/opencode-implement.json`. The OpenCode child is started with `sanitizeOpenCodeEnv: true` and does not receive `GITEA_BOT_TOKEN` or webhook secrets. After OpenCode, the **parent** reads `JUMI_PR.md` when present, commits, pushes a `jumi/issue-{n}-{slug}` branch (never the default branch, never force-push), and opens a PR whose body always includes `Fixes #n`. If the tree is clean it comments `no changes` and clears the live claim without unassigning.

Follow-up does not open a second PR. It checks out the existing `pr.head.ref`, writes `JUMI_TASK.md` plus `JUMI_FEEDBACK.md`, runs OpenCode for 60 minutes, and pushes to that same branch. Stickies go on the PR (`Jumi is addressing review comments.` → `Pushed follow-up to {url}` / `no follow-up changes` / `stuck: too many follow-up rounds`). At most 3 follow-up rounds per issue.

A scan loop (`WORKER_SCAN_INTERVAL_MS`, default 5 minutes) searches open issues assigned to the authenticated bot (`GET /repos/issues/search?type=issues&state=open&assigned=true`). Gitea's search result only embeds RepositoryMeta (`id`, `name`, `owner`, `full_name`), so the worker then `GET /repos/{owner}/{repo}` for `clone_url` / `default_branch` before cloning. If a claim PID is dead or the heartbeat is stale, the worker reclaims the same worktree and reruns. If an open **jumi** PR already closes the issue (`Fixes #n` / `Closes #n`) and there are unhandled human review comments, scan enqueues follow-up; otherwise it skips. A human-only closing PR still skips first-run and does not follow up.

The worker image is separate from the reviewer: `gitea.kirmanak.stream/personal/jumi-worker` built with `--target worker` and `CMD ["bun", "run", "src/worker_server.ts"]`. `GET /healthz` is `200 {"ok":true}`. `GET /metrics` is the same unauthenticated Prometheus token exporter as the reviewer (`runOpenCode` already calls `recordOpenCodeDb`). The worker image sets `AGENT_INSTANCE=jumi-worker` so series do not collide with the reviewer.

## Image

The reviewer image workflow publishes:

```text
gitea.kirmanak.stream/personal/jumi-reviewer:<commit-sha>
gitea.kirmanak.stream/personal/jumi-reviewer:latest
```

The worker image workflow publishes:

```text
gitea.kirmanak.stream/personal/jumi-worker:<commit-sha>
gitea.kirmanak.stream/personal/jumi-worker:latest
```

Required repository secrets for `.gitea/workflows/jumi-reviewer-image.yml` and `.gitea/workflows/jumi-worker-image.yml`:

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
| `GITEA_ALLOWED_ORGS` | `kirmanak` | Comma-separated allowed owners. Include `*` to accept every repository owner |
| `GITEA_ALLOWED_REPOS` | unset | Optional comma-separated `owner/repo` allowlist |
| `BOT_USERNAME` | `jumi` | Bot login used to find the sticky comment |
| `OPENCODE_MODEL` | `openai/gpt-5.5` | OpenCode model ID passed to `opencode run -m`; shared provider/small-model defaults come from the remote `.well-known/opencode` config |
| `OPENCODE_CONFIG` | `/app/.gitea/opencode-review.json` in the image | Reviewer OpenCode config: bash is allow-by-default; only `gitops-apply-review` is allowed; other skills denied (`skills.paths`); edit/external_directory/task/lsp stay denied; xAI/OpenAI reviewer reasoning is pinned `high` |
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
| `AGENT_INSTANCE` | `jumi` | Prometheus `agent_instance` label on `/metrics` |


## Review diagnostics (Loki)

During each review the service emits single-line structured logs prefixed with `[diag]`:

- `event=review_files` — PR file/patch sizes after limits
- `event=review_prompt` — final prompt byte size
- `event=opencode_start` — model, prompt size, parent RSS, cgroup, **per-review** OpenCode DB path/size
- `event=opencode_sample` — every ~5s while OpenCode runs: **child PID RSS**, peaks, cgroup
- `event=opencode_end` — exit code, duration, child/parent peaks, stdout/stderr byte totals
- `event=post_opencode` / `post_fetch_pr` / `post_find_sticky` / `post_sticky_result` / `post_comment_*` / `post_review_done` — **parent** RSS after OpenCode (sticky comment path)
- `event=workspace_remove_start` / `workspace_remove_end` — parent RSS around workspace cleanup

OpenCode session SQLite is forced to a temp path under the review workspace (`OPENCODE_DB=…/opencode-session.db`) so it does not accumulate on `HOME` across runs.

These are intentionally process-level so a cgroup OOM still leaves a trail of samples before death. Grep Loki with `{namespace="jumi-reviewer"} |= "[diag]"`.

## OpenCode Auth

Mount a volume at `/data` and seed OpenCode auth at:

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

Create a Gitea webhook that can reach the repos you want reviewed. For one org, use an organization webhook. For the whole instance, use a **system webhook** (Site Administration → Webhooks):

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
GET /metrics
```

`GET /metrics` is Prometheus text (`ai_tokens_total`, `ai_tokens`, `ai_sessions`) from **in-process** counters. After each OpenCode run Jumi reads the per-review session DB (even on non-zero exit), adds the token sums, then deletes the workspace as today. Totals reset on process restart; Grafana `increase()` handles that. Optional `AGENT_INSTANCE` (default `jumi`) is the series label. This is not a durable OpenCode DB on `HOME`.

## Security Model

The service rejects requests that fail any of these checks:

| Check | Enforcement |
|-------|-------------|
| Method/path | Only `POST /webhooks/gitea` is accepted |
| Content type | Must include `application/json` |
| Signature | `X-Gitea-Signature` must match the raw body HMAC-SHA256 |
| Event | Only `X-Gitea-Event: pull_request` is processed |
| Origin | Repository URLs must match `GITEA_URL` origin |
| Scope | Repository owner must be in `GITEA_ALLOWED_ORGS`, or that list must include `*` |
| Repo allowlist | `GITEA_ALLOWED_REPOS` is enforced when set |

OpenCode permissions live in `.gitea/opencode-review.json`. File edits, external directory access, tasks, questions, and LSP stay denied. Only `gitops-apply-review` is allowed; other skills denied so the reviewer can load that baked skill (Helm/K8s/`k3s/` first-apply pitfalls) from `/app/review-skills` via `skills.paths` in that JSON — not `OPENCODE_CONFIG_DIR`, which would npm-install into a config directory. Documentation lookup is allowed through OpenCode web fetch/search. Bash is **allow-by-default** (no command allowlist / no dump denylist). The image `entrypoint.sh` copies `GITEA_BOT_TOKEN` / webhook secrets to a 0600 tmpfs file, unsets them, and `exec`s bun so `/proc/<pid>/environ` is the cleaned execve image (`unsetenv` does **not** rewrite that file). `loadConfig` then reads the file and unlinks it; secrets stay in process memory only. The OpenCode child gets `XDG_CONFIG_HOME` under the ephemeral workspace so a review cannot persist a loosened `opencode.json` on the `/data` PVC. `/app` stays root-owned; only `/data` and `/work` are writable by uid 10001. xAI credentials stay in OpenCode `auth.json` on `/data` because the child needs them. Reviewer `reasoningEffort` is pinned `high` for grok-4.5, grok-4.6, and gpt-5.5. The image ships `git`, `ripgrep`, `jq`, `file`, `python3`, and pinned `helm` (no `kubectl`).

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
  opencode-implement.json    # Implement config (edit/write allow; no git commit/push)
  tool-versions.env          # Pinned OpenCode/Bun/Helm versions
  workflows/
    opencode-checks.yml      # PR lint/typecheck/test and image build checks
    jumi-reviewer-image.yml  # Reviewer image build/push workflow
    jumi-worker-image.yml    # Worker image build/push workflow
review-skills/
  gitops-apply-review/       # Baked reviewer skill (copied to /app/review-skills)
scripts/
  opencode/
    src/                     # Bun/TypeScript reviewer and issue worker
Dockerfile
renovate.json
```
