# jumi

Shared Gitea Actions for the [`kirmanak`](https://gitea.kirmanak.stream/kirmanak) organization.

## Actions

### `run-opencode`

All-in-one composite action that downloads the agent scripts, installs dependencies, and runs OpenCode.

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

## Structure

```
.gitea/
  actions/
    run-opencode/      # All-in-one composite action
  opencode.json        # OpenCode agent configuration
  tool-versions.env    # Pinned OPENCODE_VERSION (managed by Renovate)
scripts/
  opencode/            # OpenCode Gitea agent (Bun/TS)
renovate.json
```