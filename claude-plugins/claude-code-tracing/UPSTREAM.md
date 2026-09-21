# claude-code-tracing (vendored)

Claude Code hook plugin that emits OpenInference spans. Vendored from
[`Arize-ai/arize-claude-code-plugin`](https://github.com/Arize-ai/arize-claude-code-plugin)
at commit `20e97e85c22d1dee20e1d4275ac50b5360198976`, path
`plugins/claude-code-tracing/`. Upstream licence is in `LICENSE`.

The copy is vendored rather than installed because the Claude child runs with a
sanitized env, no network install onto `HOME`, and `--setting-sources user`. The
parent passes this directory with `--plugin-dir` per spawn, so the untrusted
checkout still cannot supply hooks. See `scripts/opencode/src/claude_tracing.ts`.

## What Jumi changed

Keep this list current when re-syncing with upstream.

- **Dropped the Arize AX target.** `scripts/send_span.py`, `setup.sh` and the
  Python/`opentelemetry` discovery in `common.sh` are gone. Jumi only ships
  spans to the in-cluster Phoenix service, and the image has no `opentelemetry`
  Python packages to find.
- **Dropped `skills/setup-claude-code-tracing`.** A plugin skill would load into
  every child's context and tell the model to reconfigure tracing. The parent
  owns the configuration.
- **POST through `python3`, not `curl`.** The runtime image deliberately ships
  no `curl`: the child holds a write-capable git token, and a ready-made HTTP
  client is the thing `src/forge_webfetch.ts` exists to deny. `python3` is
  already a hard dependency of the plugin (`get_timestamp_ms`). `curl` is still
  used when it is present and `python3` is not.
- **Real span kinds.** Upstream hardcodes `span_kind: "CHAIN"` on the Phoenix
  REST payload, so LLM and TOOL spans arrived as chains. The kind now comes from
  the `openinference.span.kind` attribute the hooks already set.
- **Jumi job identity on every span** (`jumi_attrs` in `common.sh`): `job_id`,
  `session.id`, `kind`, `owner`, `repo`, `sha` and `agent_instance` from the
  `JUMI_*` env the parent passes. These are the same keys the OpenCode sqlite
  exporter writes, so one Phoenix job lookup finds both runners.
- **`ARIZE_LOG_PROMPTS`** (default `false`): prompt text is not stored and no
  `input.value` is set on the turn span. Jumi prompts carry injected task,
  feedback and CI text. Tool arguments and results are unaffected.
- **Silent by default.** `log_always` and `error` no longer write to stderr
  unless `ARIZE_VERBOSE=true`. The parent classifies the child's stderr for
  auth, quota and infra death; plugin chatter must not feed that.
- **`ARIZE_LOG_FILE` defaults to empty (off).** The pod's `/tmp` is a 256Mi
  memory `emptyDir`, and upstream's `:-` default meant the documented "set empty
  to disable" never disabled anything.
- **Age-based state GC.** A child killed by timeout or a quota abort never fires
  `SessionEnd`, so `session_start.sh` also drops session state files older than
  a day instead of leaking them onto the `HOME` volume.
