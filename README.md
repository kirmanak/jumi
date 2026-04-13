# jumi

Shared Gitea Actions and scripts for the [`kirmanak`](https://gitea.kirmanak.stream/kirmanak) organization.

## Structure

```
.gitea/
  actions/
    setup-opencode/   # Install OpenCode CLI
  opencode.json       # OpenCode agent configuration
  tool-versions.env   # Pinned tool versions (managed by Renovate)
scripts/
  opencode/           # OpenCode Gitea agent (Bun/TS)
```

## Usage in other repos

Reference the opencode action and scripts from this repo in your workflows:

```yaml
steps:
  - uses: actions/checkout@v6  # checkout your repo first

  - uses: actions/checkout@v6
    with:
      repository: kirmanak/jumi
      path: jumi

  - name: Load tool versions
    run: grep -v '^#' jumi/.gitea/tool-versions.env >> "$GITHUB_ENV"

  - uses: ./jumi/.gitea/actions/setup-opencode

  - name: Run OpenCode
    env:
      OPENCODE_CONFIG: ${{ github.workspace }}/jumi/.gitea/opencode.json
      # ... other env vars
    run: bun run src/main.ts
    working-directory: jumi/scripts/opencode
```