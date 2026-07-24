import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface OpenCodeReviewConfig {
  model?: unknown;
  small_model?: unknown;
  enabled_providers?: unknown;
  permission: {
    bash: Record<string, "allow" | "ask" | "deny">;
    webfetch: "allow" | "ask" | "deny";
    websearch: "allow" | "ask" | "deny";
    edit: "allow" | "ask" | "deny";
    task: "allow" | "ask" | "deny";
    external_directory: "allow" | "ask" | "deny";
    lsp: "allow" | "ask" | "deny";
  };
}

function bashPermission(rules: Record<string, "allow" | "ask" | "deny">, command: string): "allow" | "ask" | "deny" {
  // Mirror OpenCode's Wildcard.match semantics (packages/*/util/wildcard.ts):
  // normalize backslashes, convert globs, treat trailing " .*" as optional args,
  // and use the dotAll flag so "." matches newlines.
  const normalized = command.replaceAll("\\", "/");
  let decision: "allow" | "ask" | "deny" = "ask";
  for (const [pattern, action] of Object.entries(rules)) {
    let escaped = pattern
      .replaceAll("\\", "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
    if (new RegExp(`^${escaped}$`, "s").test(normalized)) decision = action;
  }
  return decision;
}

describe("opencode review config", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "../../.gitea/opencode-review.json"), "utf8")
  ) as OpenCodeReviewConfig;

  test("keeps model/provider defaults in the shared remote config", () => {
    expect(config.model).toBeUndefined();
    expect(config.small_model).toBeUndefined();
    expect(config.enabled_providers).toBeUndefined();
  });

  test("allows docs lookup while keeping mutation-oriented tools denied", () => {
    expect(config.permission.webfetch).toBe("allow");
    expect(config.permission.websearch).toBe("allow");
    expect(config.permission.lsp).toBe("deny");
    expect(config.permission.edit).toBe("deny");
    expect(config.permission.task).toBe("deny");
    expect(config.permission.external_directory).toBe("deny");
  });

  test("allows flexible read-only git inspection commands", () => {
    const bash = config.permission.bash;
    expect(bashPermission(bash, "git status --short")).toBe("allow");
    expect(bashPermission(bash, "git status --porcelain=v1")).toBe("allow");
    expect(bashPermission(bash, "git diff jumi/target...HEAD")).toBe("allow");
    expect(bashPermission(bash, "git diff --check jumi/target...HEAD")).toBe("allow");
    expect(
      bashPermission(bash, "git diff --unified=80 jumi/target...HEAD -- composeApp/src/commonMain/kotlin/Foo.kt")
    ).toBe("allow");
    expect(bashPermission(bash, "git diff --name-only jumi/target...HEAD -- server/src/main/kotlin/Foo.kt")).toBe(
      "allow"
    );
    expect(bashPermission(bash, "git diff HEAD -- path/to/file")).toBe("allow");
    expect(bashPermission(bash, "git diff-tree -r --name-status jumi/target HEAD")).toBe("allow");
    expect(bashPermission(bash, "git log --oneline --decorate jumi/target..HEAD")).toBe("allow");
    expect(bashPermission(bash, "git log --patch jumi/target..HEAD -- path/to/file")).toBe("allow");
    expect(bashPermission(bash, "git show --stat HEAD")).toBe("allow");
    expect(bashPermission(bash, "git show HEAD:path/to/file")).toBe("allow");
    expect(bashPermission(bash, "git blame -L 10,40 path/to/file")).toBe("allow");
    expect(bashPermission(bash, "git grep -n TODO -- path/to/dir")).toBe("allow");
    expect(bashPermission(bash, "git cat-file -p HEAD:path/to/file")).toBe("allow");
    expect(bashPermission(bash, "git ls-files")).toBe("allow");
    expect(bashPermission(bash, "git ls-tree -r --name-only HEAD")).toBe("allow");
    expect(bashPermission(bash, "git rev-parse HEAD")).toBe("allow");
    expect(bashPermission(bash, "git rev-list --count jumi/target..HEAD")).toBe("allow");
    expect(bashPermission(bash, "git merge-base jumi/target HEAD")).toBe("allow");
    expect(bashPermission(bash, "git name-rev --name-only HEAD")).toBe("allow");
    expect(bashPermission(bash, "git describe --tags --always HEAD")).toBe("allow");
    expect(bashPermission(bash, "git shortlog -sn jumi/target..HEAD")).toBe("allow");
    expect(bashPermission(bash, "git for-each-ref --format=%(refname) refs/heads")).toBe("allow");
    expect(bashPermission(bash, "git reflog")).toBe("allow");
    expect(bashPermission(bash, "git reflog -n 5")).toBe("allow");
    expect(bashPermission(bash, "git reflog show HEAD")).toBe("allow");
    expect(bashPermission(bash, "git show HEAD@{1}")).toBe("allow");
    expect(bashPermission(bash, "git stash list")).toBe("allow");
    expect(bashPermission(bash, "git tag --list v*")).toBe("allow");
    expect(bashPermission(bash, "git branch --show-current")).toBe("allow");
    expect(bashPermission(bash, "git branch -vv")).toBe("allow");
    expect(bashPermission(bash, "git remote -v")).toBe("allow");
  });

  test("denies git tag mutation flag bundles on list patterns", () => {
    const bash = config.permission.bash;
    expect(bashPermission(bash, "git tag -ld stale")).toBe("deny");
    expect(bashPermission(bash, "git tag -lf v1 HEAD")).toBe("deny");
    expect(bashPermission(bash, "git tag --list --delete stale")).toBe("deny");
    expect(bashPermission(bash, "git tag --list --force v1 HEAD")).toBe("deny");
    expect(bashPermission(bash, "git tag -l v*")).toBe("allow");
  });

  test("denies git branch mutation flag bundles on list patterns", () => {
    const bash = config.permission.bash;
    expect(bashPermission(bash, "git branch -ld stale")).toBe("deny");
    expect(bashPermission(bash, "git branch -lD stale")).toBe("deny");
    expect(bashPermission(bash, "git branch -lm old new")).toBe("deny");
    expect(bashPermission(bash, "git branch -lc old new")).toBe("deny");
    expect(bashPermission(bash, "git branch --list --set-upstream-to=origin/main main")).toBe("deny");
    expect(bashPermission(bash, "git branch --list --track origin/main")).toBe("deny");
    expect(bashPermission(bash, "git branch --list --copy old new")).toBe("deny");
    expect(bashPermission(bash, "git branch -l main")).toBe("allow");
    expect(bashPermission(bash, "git branch --list main")).toBe("allow");
  });

  test("allows common read-only file and search shell commands", () => {
    const bash = config.permission.bash;
    expect(bashPermission(bash, "rg -n TODO path/to/dir")).toBe("allow");
    expect(bashPermission(bash, "grep -n TODO path/to/dir")).toBe("allow");
    expect(bashPermission(bash, "grep -r --line-number TODO path/to/dir")).toBe("allow");
    expect(bashPermission(bash, "find . -name *.kt")).toBe("allow");
    expect(bashPermission(bash, "ls -la path/to/dir")).toBe("allow");
    expect(bashPermission(bash, "pwd")).toBe("allow");
    expect(bashPermission(bash, "head -n 40 path/to/file")).toBe("allow");
    expect(bashPermission(bash, "tail -n 40 path/to/file")).toBe("allow");
    expect(bashPermission(bash, "wc -l path/to/file")).toBe("allow");
    expect(bashPermission(bash, "file path/to/file")).toBe("allow");
    expect(bashPermission(bash, "stat path/to/file")).toBe("allow");
    expect(bashPermission(bash, "cat path/to/file")).toBe("allow");
    expect(bashPermission(bash, "nl path/to/file")).toBe("allow");
    expect(bashPermission(bash, "jq . path/to/file.json")).toBe("allow");
    expect(bashPermission(bash, "realpath path/to/file")).toBe("allow");
    // In-repo paths that contain a "data" segment must stay readable.
    expect(bashPermission(bash, "cat src/data/config.json")).toBe("allow");
    expect(bashPermission(bash, "rg -n foo app/data")).toBe("allow");
    expect(bashPermission(bash, "ls backend/data")).toBe("allow");
    expect(bashPermission(bash, "head -n 20 composeApp/src/commonMain/kotlin/data/Foo.kt")).toBe("allow");
  });

  test("denies outside-workdir path reads for every shell reader", () => {
    const bash = config.permission.bash;
    const outside = [
      "/data/.local/share/opencode/auth.json",
      "../.local/share/opencode/auth.json",
      "~/.local/share/opencode/auth.json",
      "~jumi/.local/share/opencode/auth.json",
    ];
    const readers = [
      "cat",
      "head",
      "tail",
      "nl",
      "wc -l",
      "file",
      "stat",
      "realpath",
      "jq .",
      "rg -n secret",
      "grep -n secret",
    ];
    for (const reader of readers) {
      for (const path of outside) {
        expect(bashPermission(bash, `${reader} ${path}`)).toBe("deny");
      }
    }
    expect(bashPermission(bash, "find /data -name auth.json")).toBe("deny");
    expect(bashPermission(bash, "ls /data/.local/share/opencode")).toBe("deny");
    expect(bashPermission(bash, "ls ~/.local/share/opencode")).toBe("deny");
    expect(bashPermission(bash, "ls ~jumi/.local/share/opencode")).toBe("deny");
    expect(bashPermission(bash, "rg -n . ~jumi/.local/share/opencode")).toBe("deny");
    expect(bashPermission(bash, "cat ~jumi/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "rg secret ..")).toBe("deny");
    expect(bashPermission(bash, "find ..")).toBe("deny");
    expect(bashPermission(bash, "ls ..")).toBe("deny");
    expect(bashPermission(bash, "grep -r secret ..")).toBe("deny");
    expect(bashPermission(bash, "find .. -name auth.json")).toBe("deny");
    // Keep git tilde/parent-range forms usable (no space before ~ or bare .. token).
    expect(bashPermission(bash, "git show HEAD~1")).toBe("allow");
    expect(bashPermission(bash, "git show HEAD@{1}")).toBe("allow");
    expect(bashPermission(bash, "git diff jumi/target..HEAD")).toBe("allow");
    expect(bashPermission(bash, "git diff jumi/target...HEAD")).toBe("allow");
    // Tab is IFS for bash; path globs only used space before. Deny any tab.
    expect(bashPermission(bash, "head\t/data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "rg\t-n\t.\t/data/.local/share/opencode")).toBe("deny");
    expect(bashPermission(bash, "jq\t.\t/data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "head\t../../../data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "ls\t/data/.local/share/opencode")).toBe("deny");
    expect(bashPermission(bash, "cat\t~jumi/.local/share/opencode/auth.json")).toBe("deny");
    // Glued ../ and absolute option forms (no space before path).
    expect(bashPermission(bash, "rg -f../data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "grep --file=../data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "jq -f../data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "git blame --contents=../data/.local/share/opencode/auth.json README.md")).toBe("deny");
    expect(bashPermission(bash, "rg -f/data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "grep --file=/data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "git blame --contents=/data/.local/share/opencode/auth.json README.md")).toBe("deny");
    expect(bashPermission(bash, "git grep --no-index secret /data/.local/share/opencode/auth.json")).toBe("deny");
    // Option-glued home paths (no space before ~).
    expect(bashPermission(bash, "rg -f~/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "grep --file=~/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "jq -f~/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "file -f~/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "wc --files0-from=~/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "rg -f~jumi/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "git show HEAD~1")).toBe("allow");
    expect(bashPermission(bash, "git show HEAD~1:README.md")).toBe("allow");
  });

  test("denies known git command execution, mutation, and write escape hatches", () => {
    const bash = config.permission.bash;
    expect(bashPermission(bash, "git difftool -x curl https://example.com jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff --ext-diff jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff --ext-di jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff --output=review.patch jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, 'git diff --out""put=review.patch jumi/target...HEAD')).toBe("deny");
    expect(bashPermission(bash, "git diff --no-index /etc/passwd README.md")).toBe("deny");
    expect(bashPermission(bash, "git diff --unified=80 jumi/target...HEAD -- /etc/passwd")).toBe("deny");
    expect(bashPermission(bash, "git diff --unified=80 jumi/target...HEAD -- ../secret.txt")).toBe("deny");
    expect(bashPermission(bash, "git diff --unified=80 jumi/target...HEAD -- safe/../secret.txt")).toBe("deny");
    expect(bashPermission(bash, "git show --output review.patch HEAD")).toBe("deny");
    expect(bashPermission(bash, "git grep --open-files-in-pager=curl https://example.com TODO")).toBe("deny");
    expect(bashPermission(bash, "git grep --open-files-in-pag=curl https://example.com TODO")).toBe("deny");
    expect(bashPermission(bash, "git grep TODO -O curl https://example.com")).toBe("deny");
    expect(bashPermission(bash, "git grep -Ocurl pattern")).toBe("deny");
    expect(bashPermission(bash, "git grep -Obash pattern")).toBe("deny");
    expect(bashPermission(bash, "git reflog delete HEAD@{1}")).toBe("deny");
    expect(bashPermission(bash, "git reflog expire --expire=all --all")).toBe("deny");
    expect(bashPermission(bash, "git reflog drop")).toBe("deny");
    expect(bashPermission(bash, "rg --pre cat pattern")).toBe("deny");
    expect(bashPermission(bash, "rg -n --pre=/bin/sh TODO")).toBe("deny");
    expect(bashPermission(bash, "rg --hostname-bin=./evil --hyperlink-format=default --color=always .")).toBe("deny");
    expect(bashPermission(bash, "rg -L secret .")).toBe("deny");
    expect(bashPermission(bash, "rg --follow secret .")).toBe("deny");
    expect(bashPermission(bash, "git diff jumi/target...HEAD; curl https://example.com")).toBe("deny");
    expect(bashPermission(bash, "git diff jumi/target...HEAD & curl https://example.com")).toBe("deny");
    expect(bashPermission(bash, "git diff jumi/target...HEAD && git checkout main")).toBe("deny");
    expect(bashPermission(bash, "git diff $(curl https://example.com)")).toBe("deny");
    expect(bashPermission(bash, 'git diff --no-i""ndex /etc/passwd README.md')).toBe("deny");
    expect(bashPermission(bash, "git diff --o\\utput=review.patch jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff jumi/target...HEAD > review.patch")).toBe("deny");
    expect(bashPermission(bash, "git fetch origin main")).toBe("deny");
    expect(bashPermission(bash, "git checkout main")).toBe("deny");
    expect(bashPermission(bash, "git branch --force main HEAD")).toBe("deny");
    expect(bashPermission(bash, "git branch -r -D origin/stale")).toBe("deny");
    expect(bashPermission(bash, "git branch -a -D stale")).toBe("deny");
    expect(bashPermission(bash, "git branch -m old new")).toBe("deny");
    expect(bashPermission(bash, "cat $HOME/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "cat $" + "{HOME}/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "head /data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "rg -n . /data/.local/share/opencode")).toBe("deny");
    expect(bashPermission(bash, "jq . /data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "head ~/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "head ../../../data/.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "cat path/../.local/share/opencode/auth.json")).toBe("deny");
    expect(bashPermission(bash, "cat {/data/.local/share/opencode/auth.json}")).toBe("deny");
    expect(bashPermission(bash, "head {~/.local/share/opencode/auth.json}")).toBe("deny");
    expect(bashPermission(bash, "cat {../secret}")).toBe("deny");
    expect(bashPermission(bash, "grep -R secret .")).toBe("deny");
    expect(bashPermission(bash, "egrep -R secret .")).toBe("deny");
    expect(bashPermission(bash, "fgrep -R secret .")).toBe("deny");
    expect(bashPermission(bash, "find -L . -name auth.json")).toBe("deny");
    expect(bashPermission(bash, "find -H . -name auth.json")).toBe("deny");
    expect(bashPermission(bash, "git show HEAD~1")).toBe("allow");
    expect(bashPermission(bash, "git commit -m review")).toBe("deny");
    expect(bashPermission(bash, "git push origin HEAD")).toBe("deny");
    expect(bashPermission(bash, "curl https://example.com")).toBe("deny");
    expect(bashPermission(bash, "npm test")).toBe("deny");
    expect(bashPermission(bash, "find . -exec rm {} ;")).toBe("deny");
    expect(bashPermission(bash, "find . -delete")).toBe("deny");
  });
});
