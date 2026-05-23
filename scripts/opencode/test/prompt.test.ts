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
