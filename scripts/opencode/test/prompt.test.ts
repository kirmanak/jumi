import { describe, expect, test } from "bun:test";
import { buildPROpenedPrompt } from "../src/prompt.ts";
import { makeFile, makePR, makeRepo } from "./fixtures.ts";

describe("buildPROpenedPrompt", () => {
  test("escapes XML metadata and CDATA terminators", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo({ full_name: "kirmanak/a&b" }),
      pr: makePR({ title: "Fix <bug>", body: 'Uses "quotes" & apostrophes' }),
      prFiles: [makeFile({ filename: "src/<bad>.ts", patch: "before ]]> after" })],
    });

    expect(prompt).toContain("kirmanak/a&amp;b");
    expect(prompt).toContain("Fix &lt;bug&gt;");
    expect(prompt).toContain("src/&lt;bad&gt;.ts");
    expect(prompt).toContain("]]]]><![CDATA[>");
  });

  test("includes checkout target branch context", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
    });

    expect(prompt).toContain('local_branch="jumi/pr-7"');
    expect(prompt).toContain('target_branch="main"');
    expect(prompt).toContain('target_ref="jumi/target"');
    expect(prompt).toContain('target_remote_ref="origin/main"');
    expect(prompt).toContain("stable refs like jumi/target and HEAD");
    expect(prompt).toContain("git log --patch jumi/target..HEAD");
    expect(prompt).toContain("web search/fetch");
  });

  test("steers the reviewer away from denied compound shell commands", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
    });

    expect(prompt).toContain("Run exactly one shell command per tool call");
    expect(prompt).toContain("Never combine commands with &&, ;, pipes, redirection, or command substitution");
    expect(prompt).toContain("If a shell command is denied, do not retry or vary it");
    expect(prompt).toContain("switch exclusively to read/list/glob/grep");
    expect(prompt).not.toContain("one of the exact allowed examples below");
    expect(prompt).toContain("git diff --stat jumi/target...HEAD");
    expect(prompt).toContain("git diff --unified=80 jumi/target...HEAD -- path/to/file");
    expect(prompt).toContain("git blame path/to/file");
    expect(prompt).toContain("rg -n TODO path/");
    expect(prompt).not.toContain("LSP is also allowed");
    expect(prompt).not.toContain("read/list/glob/grep/lsp");
  });

  test("includes review notes", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
      reviewNotes: ["Patch budget exhausted"],
    });

    expect(prompt).toContain("<review_notes>");
    expect(prompt).toContain("Patch budget exhausted");
  });
});
