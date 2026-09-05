# House misses (visible in the diff)

These are the incidents this skill exists to catch. All had a Jumi sticky with no blocking finding.

1. **Checksum / rollout** — SOUL.md-only trim. Chart still `cp`s the file. `checksum/pulpy-config` did not move; Pulpy did not Recreate. Unittest caught it only on the follow-up.
2. **DNS the app actually dials** — Reviewer said `gitea-valkey-primary` DNS preserved (same as Penpot). Sealed `valkeyHost` still named `gitea-valkey-headless`. Valkey healthy; Gitea crashlooped. Sibling chart ≠ this host.
3. **Volume class vs Velero** — Reviewer endorsed "Velero exclude." PVC label exclude does not match generic-ephemeral. Next daily: `VeleroBackupPartiallyFailed`.
4. **Sibling resources** — Beat set to 128Mi; same image as worker already ~246Mi. First schedule: `ContainerOOMKilled`. "Follows existing pattern" was the wrong sibling.
5. **Hook process identity** — Drain matched `comm=python3`; live gateway is `comm=hermes`. A leftover `s6-svscan` question missed the match.

Not this skill: product reversals, live-DB-only bugs, follow-ups to Jumi's own comments.
