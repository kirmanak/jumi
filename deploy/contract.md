# Deploy contract

GitOps runtime contract for `jumi-reviewer` and `jumi-worker`. Not the application API.

This file is the semver source of truth. Unchanged vs the last `vX.Y.Z` tag → patch. New optional GitOps (env/port/volume) → minor. Required GitOps change (new or removed required env, UID, probe, command, port, image target), or a `BREAKING` heading/marker → major. Reviewer and worker share one version.

Notes (not keys): `JUMI_ROLE` is required (`router` or `engine`; unset, empty, or unknown fails process start). `GITEA_WEBHOOK_SECRET` is not required when `JUMI_ROLE=engine`. Worker requires `DATABASE_URL` (chart must set it; process start stays fail-closed if unset). Reviewer `DATABASE_URL` is required when `JUMI_ROLE` is `router` or `engine`. `FORGE` is optional (`gitea` or `github`; unset or empty = gitea). Router is the org-hook mailbox (assign/comment/CI/push write the shared ledger; worker HTTP is unused for correctness). Worker `workflow_job` wake uses the existing webhook port/secret (no new env).

## GitOps

### reviewer

#### required env
- `GITEA_URL`
- `GITEA_BOT_TOKEN`
- `GITEA_WEBHOOK_SECRET`
- `JUMI_ROLE`

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
- `DATABASE_URL`
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
