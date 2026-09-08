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

The service posts `jumi/opencode-review` on the PR head SHA from an explicit trailer in `JUMI_REVIEW.md` (`<!-- jumi-check: success -->` or `<!-- jumi-check: failure -->`), not from OpenCode stdout and not by grepping 🔴/🟡 in the prose:

- `pending` while the review is running
- `success` / `failure` from that trailer (❓ may still be `success`)
- `failure` if OpenCode crashes, returns empty output, or omits the trailer
- `warning` when a queued job is skipped after it already went pending (for example the PR head changed)

The trailer is kept as the last non-empty line of the sticky comment so the worker can follow up on failure. Title-gated skips (`WIP:`, `[skip review]`) still post no status.

The service intentionally does not checkout or execute PR-head code. It reviews Gitea's PR metadata and file patches from the trusted Gitea API.

`JUMI_ROLE` (default `monolith`) keeps that in-process path so existing images stay live until GitOps flips. The same reviewer image can run `JUMI_ROLE=router` (org-hook mailbox: HMAC-verify, persist `review_jobs` in Postgres, reclaim expired leases, queue metrics; no OpenCode, no HOME, no auth seed) or `JUMI_ROLE=engine` (lease a row, run OpenCode, persist `JUMI_REVIEW.md` before workspace teardown, publish sticky/status). Both need `DATABASE_URL` and `GITEA_BOT_TOKEN`. `GITEA_WEBHOOK_SECRET` is required on `router` and `monolith` only. Reviewer and worker share one `review_jobs` ledger (`kind`: `review` | `implement` | `follow-up` | `conflict`). The router writes every kind: `pull_request` opened/reopened/synchronize enqueue `review`; assign/comment/red CI enqueue `implement` / `follow-up`; default-branch `push` enqueue `conflict`; unassign cancels queued and leased worker rows for that issue and posts `stopped`. Ping is `200`. Unknown events `202`-skip. Ledger down is `503` (never `202` into RAM). The reviewer engine leases `review` only. After it publishes a current-head `<!-- jumi-check: failure -->` trailer on a jumi closing PR whose issue is still assigned `jumi`, persist inserts a `follow-up` row. That is the primary wake; scan is a backstop. The worker is not `JUMI_ROLE=router`.

## Worker Service

`jumi-worker` is a sibling service in the same Bun package. The org hook hits the **reviewer router** mailbox; worker pods do not need a public webhook path. The router HMAC-verifies and writes the shared ledger. The worker only **leases** `implement` / `follow-up` / `conflict` and runs OpenCode. Worker HTTP (`POST /webhooks/gitea`) still exists for local/dev and healthz/metrics, but it is unused for correctness once GitOps points the org hook at the router. Work runs only when the issue or pull request is assigned to bot username `jumi` (`BOT_USERNAME`, default `jumi`). Pull-request issues (`issue.pull_request` present / non-null) are ignored for first-run implement; assigning an already-open PR (any author, including Renovate) is follow-up on that PR's head ref instead. Org-hook checkboxes and GitOps IngressRoutes are not configured in this repo. When `DATABASE_URL` is set, webhooks only enqueue (202) into the shared Postgres envelope and the worker leases with `FOR UPDATE SKIP LOCKED` (distinct owner per process; never the same row twice). First-run keeps that job row after the PR opens. Either replica may lease or scan; enqueue stays idempotent. Unassign is the kill switch via the ledger (queued and leased worker rows become cancelled); the running worker aborts when its lease is gone. The router does not kill processes. When `DATABASE_URL` is unset, today's in-memory queue and HOME JSON claims still handle first-run assign (fail closed for the Postgres graph: do not 202 those jobs into RAM).

Gitea 1.27 delivers assignment as a grouped issue event, not a GitHub-style top-level `assignee` field:

- Headers: `X-Gitea-Event: issues` and `X-Gitea-Event-Type: issue_assign` (also `X-GitHub-Event` / `X-GitHub-Event-Type`).
- Body: `IssuePayload` with `action`, `number`, `issue`, `repository`, `sender` (`modules/structs/hook.go`). `issue.assignee` / `issue.assignees` are `User` objects with `login` (and compat `username`).
- Actions: `issues` → `opened`/`closed`/`reopened`/`edited`/`deleted`; `issue_assign` → `assigned`/`unassigned`.
- The org/system hook must enable **both** `Issues` and `Issue Assign` (separate Gitea checkboxes). `Issues` alone will not fire on assign.

Webhook handling:

- `X-Gitea-Event: issues` or `issue_assign` with action `assigned`, `opened`, or `reopened` (and assigned to the bot) → enqueue first-run implement
- `unassigned` when the bot is no longer an assignee → cancel: mark queued and leased worker jobs for that issue cancelled; the holder's heartbeat fail-closes and aborts its child (do not `kill` an unrelated process); comment `stopped`; delete the claim, follow-up, and conflict state files
- `unassigned` when the bot remains among multiple assignees → no cancel
- `X-Gitea-Event: issue_comment` / `pull_request_comment` with action `created` on an open jumi closing PR or an assigned foreign PR (human sender, non-empty body, not a jumi sticky) → enqueue follow-up keyed by the closed issue or the PR number
- `X-Gitea-Event: pull_request_rejected` on an open jumi closing PR or assigned foreign PR → enqueue follow-up
- `X-Gitea-Event: push` on `refs/heads/<repository.default_branch>` → mechanical HTTP filter (list open managed jumi closers and assigned foreign PRs; no git, no OpenCode). Enqueue `mode: "conflict"` keyed by the issue or PR number. Tags, deletes, and non-default branches skip.
- `X-Gitea-Event: workflow_job` → wake only (202 immediately; no git, no OpenCode). Malformed / not-ours → 202 skip, never 400. Do not use `status` (also fires for Jumi reviews). The job re-reads **live** commit statuses for `pr.head.sha`, ignores `jumi/opencode-review`, skips if any other context is `pending`, and on a non-jumi `failure` injects a capped log tail (`JUMI_CI.md`) then follow-up on the existing branch.
- `X-Gitea-Event: pull_request` / `pull_request_assign` with action `assigned` (bot still assigned) → enqueue follow-up keyed by the PR number. `unassigned` when the bot is no longer an assignee → cancel that PR. Any other `pull_request` action → `202` skip, never 400 (reviewer still owns opened/synchronize).
- `X-Gitea-Event: ping` → `200 {"ok":true}`
- other events → `202` skip

Skip follow-up when the sender is `jumi`, the comment was `edited`/`deleted`, the body is empty or contains `<!-- jumi-worker:` / `<!-- jumi-check:`, the PR is a fork/draft/`WIP:`, the closing issue is not assigned to the bot, or a foreign PR is not assigned to the bot.

Without `DATABASE_URL`, on enqueue the parent claims the issue with a PID/heartbeat file under `{HOME}/worker/jobs/{owner}/{repo}/{number}.json`. A claim is live only while that PID is alive **and** the heartbeat is newer than two minutes. With `DATABASE_URL`, the Postgres lease is the identity (no JSON claim as source of truth; HOME claims are not the cross-replica lock). Heartbeat fail-closes if the row is no longer leased by that owner (cancelled, stolen, expired) so a cancelled job does not burn the rest of the implement timeout. The parent clones a bare cache and worktree from the default branch, writes `JUMI_TASK.md`, and runs `opencode run` with `.gitea/opencode-implement.json`. The OpenCode child is started with `sanitizeOpenCodeEnv: true` and does not receive `GITEA_BOT_TOKEN` or webhook secrets. After OpenCode, the **parent** reads `JUMI_PR.md` when present, commits, pushes a `jumi/issue-{n}-{slug}` branch (never the default branch, never force-push), and opens a PR whose body always includes `Fixes #n`. If the tree is clean it comments `no changes` and clears the live claim without unassigning. The first implement job row stays in the ledger after the PR opens.

Follow-up does not open a second PR. It checks out the existing `pr.head.ref`, merges `origin/<default>` into that branch, writes `JUMI_TASK.md` plus `JUMI_FEEDBACK.md`, and when the current head has a failed non-jumi check writes `JUMI_CI.md` (parent-injected log tail: last `##[error]` plus ~80 lines, 32–64 KiB, unpack noise dropped). The OpenCode child has git push creds only — no bot token, no `tea`, no Actions fetch. Runs OpenCode for 60 minutes, and pushes to that same branch (merge + review fixes can share one push). Stickies go on the PR (`Jumi is addressing review comments.` / `Jumi is addressing CI failure.` → `Pushed follow-up to {url}` / `no follow-up changes` / `stuck: too many follow-up rounds`). At most 3 review-comment follow-up rounds per issue. CI follow-up is one OpenCode per `{head SHA, failed check name}` unless the log hash changes; that budget is not shared with review-comment rounds. Known infra flakes (GitHub `140.82` checkout/cache timeout or unreachable, Helm remote-schema timeout/429, GARM `Invalid cross-device link` on dpkg, tofu S3 state lock) comment for a human and do not burn an OpenCode round. Unknown red → OpenCode. If the default-branch merge is stuck, follow-up does not run the feedback OpenCode that round.

Conflict jobs also stay on the existing branch: `git merge --no-ff origin/<default>` (never rebase, never force-push, never a second PR). OpenCode runs only if conflict markers remain after the merge and Chart.lock regen (`helm dependency update`). Timeout is 60 minutes. At most 3 conflict rounds per issue. Already-up-to-date is silent (no PR sticky). Success comments `Pushed merge of {default}.` on the PR; unresolved markers comment `stuck: cannot resolve conflicts` without unassigning.

A scan loop (`WORKER_SCAN_INTERVAL_MS`, default 5 minutes) is a backstop and may run on every replica. Dedup is the ledger. It searches open issues **and pulls** assigned to the authenticated bot (`GET /repos/issues/search?type=issues|pulls&state=open&assigned=true`). Gitea's search result only embeds RepositoryMeta (`id`, `name`, `owner`, `full_name`), so the worker then `GET /repos/{owner}/{repo}` for `clone_url` / `default_branch` before cloning. If a claim PID is dead or the heartbeat is stale, the worker reclaims the same worktree and reruns. Assigned foreign PRs (open, not draft/`WIP:`, not a fork; author and branch name do not matter) use the PR number as the job identity and never open a second PR or `jumi/issue-*` branch. Green tip (no in-scope comments, no current-head failure trailer, no red non-jumi check, mergeable) is a no-op. If an open **jumi** PR already closes an assigned issue (`Fixes #n` / `Closes #n`): unhandled human review comments or a current-head Jumi reviewer sticky with `<!-- jumi-check: failure -->` enqueue follow-up (which prefixes the default-branch merge); else a red non-jumi Actions check on the current head with no other non-jumi context still `pending` enqueues the same CI follow-up (scan is the backstop if the `workflow_job` hook lagged); else `mergeable === false` enqueues a conflict job; omitted/`null` mergeable does not. Missing trailer / stub / `success` is not a finding. Do not grep 🔴. Do not treat the Jumi review commit status as a trailer substitute. A human-only closing PR still skips first-run and does not conflict-follow unless that PR itself is assigned to jumi. An assigned foreign PR is the one jumi job in that repo (do not also first-run another assigned issue). Unassign remains the kill switch. Max follow-up rounds stay 3. A new head SHA cancels queued predecessor follow-up/conflict for that PR; if HEAD moved mid-job, skip that round. Never amend someone else's commit, force-push, rebase, or merge the PR.

The worker image is separate from the reviewer: `gitea.kirmanak.stream/personal/jumi-worker` built with `--target worker` and `CMD ["bun", "run", "src/worker_server.ts"]`. `GET /healthz` is `200 {"ok":true}`. `GET /metrics` is the same unauthenticated Prometheus token exporter as the reviewer (`runOpenCode` already calls `recordOpenCodeDb`). The worker image sets `AGENT_INSTANCE=jumi-worker` so series do not collide with the reviewer.

## Image

The reviewer image workflow publishes:

```text
gitea.kirmanak.stream/personal/jumi-reviewer:<commit-sha>
gitea.kirmanak.stream/personal/jumi-reviewer:latest
gitea.kirmanak.stream/personal/jumi-reviewer:vX.Y.Z
```

The worker image workflow publishes:

```text
gitea.kirmanak.stream/personal/jumi-worker:<commit-sha>
gitea.kirmanak.stream/personal/jumi-worker:latest
gitea.kirmanak.stream/personal/jumi-worker:vX.Y.Z
```

Reviewer and worker share one immutable semver tag per merge to `main`. `deploy/contract.md` is the bump source of truth (unchanged → patch, new optional GitOps → minor, required GitOps change or `BREAKING` → major). The first release is `v1.0.0`. A Gitea Release on that tag has `## GitOps` / `## Breaking` / `## Changes`. Images carry `org.opencontainers.image.source`, `version` (`vX.Y.Z`), and `revision` (full SHA). GitOps pin/changelog wiring is a follow-up in `server_configuration`, not this repo.

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
| `GITEA_WEBHOOK_SECRET` | Secret used to verify `X-Gitea-Signature`. Required for `monolith`/`router`; not required for `engine` |

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
| `OPENCODE_CONFIG` | `/app/.gitea/opencode-review.json` in the image | Reviewer OpenCode config: bash is allow-by-default; edit/write are allowed so the reviewer can write `JUMI_REVIEW.md`; only `gitops-apply-review` is allowed (`skills.paths`); other skills denied; external_directory/task/lsp stay denied; xAI/OpenAI reviewer reasoning is pinned `high` |
| `OPENCODE_WELLKNOWN_URL` | `https://kirmanak.stream` | Remote OpenCode config origin. The service seeds a `wellknown` auth entry so OpenCode loads `/.well-known/opencode` before the local review policy. |
| `OPENCODE_WELLKNOWN_KEY` | `OPENCODE_WELLKNOWN_TOKEN` | Logical key name recorded in OpenCode auth for the well-known provider |
| `OPENCODE_WELLKNOWN_TOKEN` | `unused` | Token placeholder for the public well-known config entry |
| `HOME` | `/data` in the image | OpenCode auth storage root |
| `WORKDIR` | `/work` in the image | Temporary review workspace root |
| `QUEUE_CONCURRENCY` | `1` | Review worker concurrency |
| `MAX_FILES` | `100` | Max changed files sent to OpenCode |
| `MAX_PATCH_BYTES` | `500000` | Max patch bytes sent to OpenCode |
| `MAX_OUTPUT_BYTES` | `80000` | Max OpenCode stdout bytes and max `JUMI_REVIEW.md` bytes; oversized artifacts fail closed without a sticky |
| `MAX_WEBHOOK_BYTES` | `1048576` | Max accepted webhook payload bytes |
| `OPENCODE_TIMEOUT_MS` | `900000` | OpenCode run timeout |
| `FOLLOWUP_TIMEOUT_MS` | `3600000` | Follow-up OpenCode run timeout. Does not inherit `OPENCODE_TIMEOUT_MS` |
| `CONFLICT_TIMEOUT_MS` | `3600000` | Conflict OpenCode run timeout. Does not inherit `OPENCODE_TIMEOUT_MS` |
| `MAX_FOLLOWUP_ROUNDS` | `3` | Max follow-up OpenCode rounds per issue |
| `MAX_CONFLICT_ROUNDS` | `3` | Max conflict OpenCode rounds per issue |
| `AGENT_INSTANCE` | `jumi` | Prometheus `agent_instance` label on `/metrics` |
| `JUMI_ROLE` | `monolith` | `monolith` (in-process queue, current behaviour), `router` (org-hook mailbox + PG enqueue/reclaim; no OpenCode), or `engine` (lease + OpenCode). Unset is `monolith`. |
| `DATABASE_URL` | unset | Postgres URL. Required for `router`/`engine`; ignored by `monolith`. GitOps must set it on the worker; process start stays fail-closed if unset (first-run assign uses the in-memory queue). When set, implement/follow-up/conflict use the shared `review_jobs` ledger |
| `LEASE_MS` | `OPENCODE_TIMEOUT_MS + 10m` | Engine lease length before reclaim |
| `MAX_JOB_ATTEMPTS` | `2` | Reclaim requeues until this many attempts, then fails the job. SIGTERM/SIGINT on a reviewing engine or implementing worker aborts OpenCode and requeues the same job without consuming an attempt. Crash/OOM still uses reclaim. |


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

The router processes `opened`, `reopened`, and new-commit synchronization as reviews. Assign, unassign, comments, red CI (`workflow_job`), and default-branch `push` write worker ledger jobs (or cancel in-flight worker rows). PR description edits and other unknown events are acknowledged and skipped. Org-hook checkboxes are GitOps, not this repo.

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
| Event | Router: org-hook events (`pull_request` review + assign/comment/CI/push worker kinds). Ping `200`. Unknown `202`-skip. Monolith: `pull_request` review actions. Engine: webhook disabled |
| Origin | Repository URLs must match `GITEA_URL` origin |
| Scope | Repository owner must be in `GITEA_ALLOWED_ORGS`, or that list must include `*` |
| Repo allowlist | `GITEA_ALLOWED_REPOS` is enforced when set |

OpenCode permissions live in `.gitea/opencode-review.json`. Edit/write are allowed so the reviewer can write `JUMI_REVIEW.md`. External directory access, tasks, questions, and LSP stay denied. Only `gitops-apply-review` is allowed; other skills denied so the reviewer can load that baked skill (Helm/K8s/`k3s/` first-apply pitfalls) from `/app/review-skills` via `skills.paths` in that JSON — not `OPENCODE_CONFIG_DIR`, which would npm-install into a config directory. Documentation lookup is allowed through OpenCode web fetch/search. Bash is **allow-by-default** (no command allowlist / no dump denylist). The image `entrypoint.sh` copies `GITEA_BOT_TOKEN` / webhook secrets to a 0600 tmpfs file, unsets them, and `exec`s bun so `/proc/<pid>/environ` is the cleaned execve image (`unsetenv` does **not** rewrite that file). `loadConfig` then reads the file and unlinks it; secrets stay in process memory only. The OpenCode child gets `XDG_CONFIG_HOME` under the ephemeral workspace so a review cannot persist a loosened `opencode.json` on the `/data` PVC. `/app` stays root-owned; only `/data` and `/work` are writable by uid 10001. xAI credentials stay in OpenCode `auth.json` on `/data` because the child needs them. Reviewer `reasoningEffort` is pinned `high` for grok-4.5, grok-4.6, and gpt-5.5. The image ships `git`, `ripgrep`, `jq`, `file`, `python3`, and pinned `helm` (no `kubectl`).

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
    jumi-release.yml         # Annotated vX.Y.Z git tag + Gitea Release
deploy/
  contract.md                # GitOps runtime contract (semver source of truth)
review-skills/
  gitops-apply-review/       # Baked reviewer skill (copied to /app/review-skills)
scripts/
  opencode/
    src/                     # Bun/TypeScript reviewer and issue worker
Dockerfile
renovate.json
```
