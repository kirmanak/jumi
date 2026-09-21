# Deploy contract

GitOps runtime contract for `jumi-reviewer` and `jumi-worker`. Not the application API.

This file is the semver source of truth. Unchanged vs the last `vX.Y.Z` tag → patch. New optional GitOps (env/port/volume) → minor. Required GitOps change (new or removed required or gitops env, UID, probe, command, port, image target), or a `BREAKING` heading/marker → major. Reviewer and worker share one version.

Env headings: `required env` fails process start when unset. `gitops env` must be set by GitOps/chart, but process start tolerates unset (local/dev only). `optional env` has a default. CI checks these headings against the loaders (`requireEnv` → required env; any other read → gitops or optional env).

Notes (not keys): `JUMI_ROLE` is required (`router` or `engine`; unset, empty, or unknown fails process start). `GITEA_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET` is not required when `JUMI_ROLE=engine`. Reviewer `DATABASE_URL` is required: router and engine fail process start without it. Worker `DATABASE_URL` is gitops env: the chart must set it (the worker then leases jobs from the shared ledger); without it the worker still starts for local/dev with an in-process queue and no ledger tick, and logs `ledger=none`. Do not 202 org-hook jobs into that RAM queue. `FORGE` is optional (`gitea` or `github`; unset or empty = gitea). Router is the org-hook mailbox (assign/comment/CI/push write the shared ledger; worker HTTP is unused for correctness). Worker `workflow_job` wake uses the existing webhook port/secret (no new env). `OPENCODE_WELLKNOWN_URL=disabled` turns well-known off (no seed, no fetch); unset or empty still defaults to `https://kirmanak.stream`; other non-URL values fail closed. `JUMI_RUNNERS_FILE` may name `type: claude` runners (`model`, optional `effort` — one of `low`, `medium`, `high`, `xhigh`, `max`, since claude only *warns* about a level it does not know and then runs at the default; anything else fails process start; spawn `--setting-sources user`). Unset still synthesizes an OpenCode-only chain from `OPENCODE_*`. Do not bake Claude model ids into the image. `CLAUDE_CODE_OAUTH_TOKEN` stays in the parent env, not this file. `JUMI_RUNNERS_FILE` may also name `type: agy` runners (official Antigravity CLI `agy -p`; `model`, optional `effort`) for the isolated GitHub factory; the default synthesized chain never selects it. Do not bake `agy` model ids into the image. `agy` auth is the operator's own login under `$HOME/.gemini/antigravity-cli/` (inside `/data`); keep that tree on the retained auth volume like `$HOME/.claude`, one login per ordinal, never a shared or CI-minted token.

## GitOps

### reviewer

#### required env
- `GITEA_URL`
- `GITEA_BOT_TOKEN`
- `GITEA_WEBHOOK_SECRET`
- `JUMI_ROLE`
- `DATABASE_URL`

#### gitops env

#### optional env
- `HOST`
- `PORT`
- `FORGE`
- `GITEA_WEBHOOK_AUTH_TOKEN`
- `GITEA_ALLOWED_ORGS`
- `GITEA_ALLOWED_REPOS`
- `BOT_USERNAME`
- `FOLLOWUP_IGNORE_LOGINS`
- `OPENCODE_MODEL`
- `OPENCODE_VARIANT`
- `OPENCODE_FALLBACK_MODEL`
- `OPENCODE_FALLBACK_VARIANT`
- `JUMI_RUNNERS_FILE`
- `OPENCODE_CONFIG`
- `OPENCODE_WELLKNOWN_URL`
- `OPENCODE_WELLKNOWN_KEY`
- `OPENCODE_WELLKNOWN_TOKEN`
- `HOME`
- `WORKDIR`
- `QUEUE_CONCURRENCY`
- `MAX_FILES`
- `MAX_PATCH_BYTES`
- `MAX_OUTPUT_BYTES`
- `MAX_WEBHOOK_BYTES`
- `OPENCODE_TIMEOUT_MS`
- `LEASE_MS`
- `MAX_JOB_ATTEMPTS`
- `PHOENIX_OTLP_ENDPOINT`

#### ports
- `3000`

#### runAs
- `10001:10001`

#### probes
- `GET /healthz port 3000`

#### command
- `bun run src/server.ts`

#### image target
- `runtime`

#### volumes
- `/data`
- `/work`

### worker

#### required env
- `GITEA_URL`
- `GITEA_BOT_TOKEN`
- `GITEA_WEBHOOK_SECRET`

#### gitops env
- `DATABASE_URL`

#### optional env
- `HOST`
- `PORT`
- `FORGE`
- `GITEA_WEBHOOK_AUTH_TOKEN`
- `GITEA_ALLOWED_ORGS`
- `GITEA_ALLOWED_REPOS`
- `BOT_USERNAME`
- `FOLLOWUP_IGNORE_LOGINS`
- `OPENCODE_MODEL`
- `OPENCODE_VARIANT`
- `OPENCODE_FALLBACK_MODEL`
- `OPENCODE_FALLBACK_VARIANT`
- `JUMI_RUNNERS_FILE`
- `OPENCODE_CONFIG`
- `OPENCODE_WELLKNOWN_URL`
- `OPENCODE_WELLKNOWN_KEY`
- `OPENCODE_WELLKNOWN_TOKEN`
- `HOME`
- `WORKDIR`
- `QUEUE_CONCURRENCY`
- `MAX_OUTPUT_BYTES`
- `MAX_WEBHOOK_BYTES`
- `OPENCODE_TIMEOUT_MS`
- `FOLLOWUP_TIMEOUT_MS`
- `CONFLICT_TIMEOUT_MS`
- `MAX_FOLLOWUP_ROUNDS`
- `MAX_CONFLICT_ROUNDS`
- `LEASE_MS`
- `MAX_JOB_ATTEMPTS`
- `PHOENIX_OTLP_ENDPOINT`

#### ports
- `3000`

#### runAs
- `10001:10001`

#### probes
- `GET /healthz port 3000`

#### command
- `bun run src/worker_server.ts`

#### image target
- `worker`

#### volumes
- `/data`
- `/work`
