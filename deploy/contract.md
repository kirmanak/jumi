# Deploy contract

GitOps runtime contract for `jumi-reviewer` and `jumi-worker`. Not the application API.

This file is the semver source of truth. Unchanged vs the last `vX.Y.Z` tag → patch. Additive GitOps → minor. Removed required env/port/user/probe/command/target, or a `BREAKING` heading/marker → major. Reviewer and worker share one version.

Notes (not keys): `GITEA_WEBHOOK_SECRET` is not required when `JUMI_ROLE=engine`. `DATABASE_URL` is required only when `JUMI_ROLE` is `router` or `engine` (default `monolith` does not need it).

## GitOps

### reviewer

#### required env
- `GITEA_URL`
- `GITEA_BOT_TOKEN`
- `GITEA_WEBHOOK_SECRET`

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
