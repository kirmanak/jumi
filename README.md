# jumi

Shared Gitea Actions for the [`kirmanak`](https://gitea.kirmanak.stream/kirmanak) organization.

## Actions

### `run-opencode`

All-in-one composite action that downloads the agent scripts, installs dependencies, and runs OpenCode. Use this in **other** repositories that want to run OpenCode.

```yaml
steps:
  - uses: actions/checkout@v6
    with:
      fetch-depth: 0
      token: ${{ secrets.OPENCODE_BOT_TOKEN }}

  - uses: https://gitea.kirmanak.stream/kirmanak/jumi/.gitea/actions/run-opencode@main
    with:
      gitea-token: ${{ secrets.OPENCODE_BOT_TOKEN }}
      opencode-model: ${{ vars.OPENCODE_MODEL }}
      opencode-go-api-key: ${{ secrets.OPENCODE_GO_API_KEY }}
      copilot-github-key: ${{ secrets.COPILOT_GITHUB_KEY }}
```

No other checkout or setup steps needed — the action fetches scripts from this repo via the Gitea API.

## Self-Hosting

This repository can also run OpenCode on itself. The following workflows are enabled when jumi is used as a standalone project:

### Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `opencode-review.yml` | Pull request creation/update | Auto-reviews PRs with OpenCode |

### Required Configuration

The following secrets and variables must be configured in the repository:

| Name | Type | Description |
|------|------|-------------|
| `OPENCODE_BOT_TOKEN` | Secret | Gitea API token with repo access |
| `LITELLM_AI_KEY` | Secret | API key for the LiteLLM provider |
| `OPENCODE_MODEL` | Variable | Model identifier (e.g., `litellm/large`) |

### Structure

```
.gitea/
  actions/
    run-opencode/      # All-in-one composite action (for other repos)
    setup-opencode/    # Installs OpenCode CLI
  opencode.json        # OpenCode agent configuration
  tool-versions.env    # Pinned OPENCODE_VERSION (managed by Renovate)
  workflows/
    opencode-review.yml # PR auto-review
scripts/
  opencode/            # OpenCode Gitea agent (Bun/TS)
renovate.json
```