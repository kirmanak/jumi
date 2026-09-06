---
name: gitops-apply-review
description: Use when the diff touches Helm, Kubernetes, k3s/, Chart.yaml, or values.yaml, or when the PR is a Renovate docker bump of jumi-reviewer / jumi-worker. Catch first-apply explosions visible in the diff: checksum/rollout, Service DNS host keys vs names, Velero vs generic-ephemeral, sibling memory limits, hook comm vs argv. Parse PR body ## GitOps notes on Jumi image bumps. Do not read charts/*.tgz.
---

# gitops-apply-review

House eyes for Helm/K8s/`k3s/` diffs. Catch "Jumi green, first apply explodes" from the **diff**, not from live cluster state.

Load this skill via the skill tool. Do not Read `/app/review-skills` yourself.

## Tools in this image

- `python3` — run the **changed chart's** existing unittest if present.
- `helm template` — **changed chart only**, offline from that chart's vendored `charts/*.tgz`. Seconds.
- Never `helm upgrade`, `helm install`, or `kubectl apply`. No cluster, no kubeconfig, no `kubectl`.
- Never open, Read, Glob, or `git show` `charts/*.tgz` (that path OOMs / 143s). If you need rendered YAML, `helm template` the changed chart.
- Do not dump SealedSecret / secret **values**. Grep host **keys** only (`valkeyHost`, hostname fields).
- A sibling chart's Service name is not proof this app dials that host.

## Checklist

1. **Checksum / rollout** — ConfigMap, Secret, or mounted file content changed? Matching `checksum/...` annotation (or equivalent) on the workload that must restart? A `cp` of the file in the chart is not a rollout. Recreate vs RollingUpdate matters when the process does not reload in place.
   - `rg -n 'checksum/' <chart>` and compare the annotated object to the file that changed.
   - If unittest exists and asserts checksums, run it. "Chart still copies SOUL.md" is not the question; "did `checksum/pulpy-config` move?" is.

2. **DNS the app actually dials** — Deleted or renamed Service? Grep host **keys** in values/templates against **rendered Service names**. Headless vs primary vs `*-headless`. Sibling chart DNS preserved ≠ this chart's `*Host` key.
   - `rg -n 'Host|host:|hostname' <chart> --glob '!charts/**'`
   - Compare keys to `metadata.name` on Services in `helm template` output, not to another app's chart.
   - Example miss: `gitea-valkey-primary` still exists (Penpot-shaped) while sealed `valkeyHost` names `gitea-valkey-headless`. Valkey healthy; Gitea crashloops.

3. **Volume class vs Velero** — New volume? PVC label `velero.io/exclude-from-backup` does **not** apply to generic-ephemeral. Check the actual volume kind and whether Velero FS backup will still see the path.
   - Look for `ephemeral:`, `generic-ephemeral`, volumeClaimTemplates, vs `kind: PersistentVolumeClaim`.
   - Exclude labels on PVCs do not follow emptyDir or generic-ephemeral. Next daily backup: `VeleroBackupPartiallyFailed`.

4. **Sibling resources** — New sidecar, init, or beat using the **same image** as an existing container? Compare memory to that sibling, not to an unrelated smaller container in the same chart.
   - Same image repo/tag → start from that container's `resources.limits.memory`, not from a redis/exporter sidecar.
   - Example miss: beat at 128Mi while the worker already ~246Mi on the same image. First schedule: `ContainerOOMKilled`. "Follows existing pattern" picked the wrong sibling.

5. **Hook process identity** — preStop / drain / hooks matching `comm=` or argv? Match the live binary, not the name in a comment (`comm=python3` while the gateway is `comm=hermes`).
   - Read the command/args of the container the hook targets. Ignore comments.
   - A leftover `s6-svscan` question is not a substitute for matching `comm=` to argv.

6. **Scope** — Changed chart only. Do not walk every tgz in the repo.

## Render (changed chart only)

If templates or values changed and unittest / `helm template` can run from the checkout:

```
helm template <release> <chart-dir> -f <values>
```

Use the directory of the **changed** chart. Chart dependencies are already vendored as `charts/*.tgz` next to that chart — pass the chart dir to helm; do not glob or read those archives.

If the chart has a python unittest, run it with `python3`. Fail the review if that unittest fails. A checksum unittest would have caught the SOUL.md trim locally.

## Jumi image bumps

When the PR is a Renovate docker bump of `jumi-reviewer` / `jumi-worker` (title/body `depName` or image repo), parse the PR body `## GitOps` section. Do not treat commit status as notes.

- Missing `## GitOps` → 🟡 risk: no GitOps notes; cannot tell if values need edits
- Section is `none` and the diff is only tag/digest → no extra 🔴 from this rule
- Non-empty GitOps bullets and `values.yaml` (or the chart) does not make those edits → 🔴 bug

## Do not

- Write `LEARNINGS.md` or append reviewer memory. After a deploy blow-up that was **visible in the diff**, humans patch this skill (or that repo's `REVIEW.md`) in a follow-up PR.
- Re-flag accepted tradeoffs (`GIT_AUTH_TOKEN` in the worker child, xAI `auth.json` readable under open bash) unless this PR changes them.
- Overfit: product reversals, live-DB-only bugs, and follow-ups to Jumi's own comments are not this skill.

Worked house misses (same paths, Jumi green → hotfix): `references/house-misses.md`.
