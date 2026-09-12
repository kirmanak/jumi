import { describe, expect, test } from "bun:test";
import { findingFingerprint, parseReviewFindings, parseReviewOutput, stripFindingLines } from "../src/verdict.ts";

describe("parseReviewOutput", () => {
  test("reads an explicit success check and strips it from the comment", () => {
    expect(parseReviewOutput("Looks good.\n\nNo correctness bugs.\n<!-- jumi-check: success -->")).toEqual({
      comment: "Looks good.\n\nNo correctness bugs.",
      checkLine: "<!-- jumi-check: success -->",
      verdict: { state: "success", description: "No blocking issues", incomplete: false },
    });
  });

  test("reads an explicit failure check with a reason", () => {
    const output = [
      "L12: 🔴 bug: null deref. Guard it.",
      "L40: 🟡 risk: swallowed error. Fail closed.",
      "<!-- jumi-check: failure; 1 blocking, 1 risk -->",
    ].join("\n");
    expect(parseReviewOutput(output)).toEqual({
      comment: "L12: 🔴 bug: null deref. Guard it.\nL40: 🟡 risk: swallowed error. Fail closed.",
      checkLine: "<!-- jumi-check: failure; 1 blocking, 1 risk -->",
      verdict: { state: "failure", description: "1 blocking, 1 risk", incomplete: false },
    });
  });

  test("accepts a check comment only as the last non-empty line", () => {
    const output = [
      "Do not grep 🔴. Ask for `<!-- jumi-check: failure -->` instead.",
      "❓ q: why special-case 🔴?",
      "<!-- jumi-check: success -->",
    ].join("\n");
    expect(parseReviewOutput(output).verdict).toEqual({
      state: "success",
      description: "No blocking issues",
      incomplete: false,
    });
  });

  test("ignores a quoted check comment that is not the whole last line", () => {
    const output = ["<!-- jumi-check: failure; 1 risk -->", "example: <!-- jumi-check: success -->"].join("\n");
    expect(parseReviewOutput(output).verdict).toEqual({
      state: "failure",
      description: "Incomplete review: no check verdict",
      incomplete: true,
    });
  });

  test("fails closed when the last line is prose after a trailer", () => {
    const output = ["Looks good.", "<!-- jumi-check: success -->", "Hope this helps."].join("\n");
    expect(parseReviewOutput(output).verdict.incomplete).toBe(true);
  });

  test("fails closed when the check comment is missing", () => {
    expect(parseReviewOutput("Looks good.\n\nNo correctness bugs.")).toEqual({
      comment: "Looks good.\n\nNo correctness bugs.",
      verdict: { state: "failure", description: "Incomplete review: no check verdict", incomplete: true },
    });
  });

  test("fails empty output as incomplete", () => {
    expect(parseReviewOutput("   ")).toEqual({
      comment: "",
      verdict: { state: "failure", description: "Incomplete review: no output", incomplete: true },
    });
  });

  test("treats a stub without a check comment as incomplete", () => {
    expect(parseReviewOutput("I'll inspect the PR and check for correctness issues.").verdict).toEqual({
      state: "failure",
      description: "Incomplete review: no check verdict",
      incomplete: true,
    });
  });
});

describe("parseReviewFindings", () => {
  test("parses file:line findings and skips lines without a usable path or line", () => {
    const text = [
      "src/foo.ts:12: 🔴 bug: null deref. Guard it.",
      "No location on this sentence.",
      "deploy/contract.md:1: 🟡 risk: missing env.",
      "../secret:3: 🔴 bug: skip traversal.",
      "src/bar.ts:0: 🔴 bug: skip zero.",
      "- src/list.ts:9: 💡 simpler: drop the helper.",
    ].join("\n");
    expect(parseReviewFindings(text)).toEqual([
      { path: "src/foo.ts", line: 12, body: "🔴 bug: null deref. Guard it." },
      { path: "deploy/contract.md", line: 1, body: "🟡 risk: missing env." },
      { path: "src/list.ts", line: 9, body: "💡 simpler: drop the helper." },
    ]);
  });

  test("resolves L-form only when a single-file path is provided", () => {
    const text = "L12: 🔴 bug: null deref. Guard it.\nL40: ❓ q: why swallow errors?";
    expect(parseReviewFindings(text)).toEqual([]);
    expect(parseReviewFindings(text, { singleFilePath: "src/demo.ts" })).toEqual([
      { path: "src/demo.ts", line: 12, body: "🔴 bug: null deref. Guard it." },
      { path: "src/demo.ts", line: 40, body: "❓ q: why swallow errors?" },
    ]);
    expect(parseReviewFindings(text, { singleFilePath: "../oops.ts" })).toEqual([]);
  });

  test("strips locatable findings and keeps prose", () => {
    const text = [
      "src/foo.ts:12: 🔴 bug: null deref. Guard it.",
      "plain prose without a location",
      "L12: ❓ q: is the timeout intentional?",
    ].join("\n");
    expect(stripFindingLines(text)).toBe("plain prose without a location\nL12: ❓ q: is the timeout intentional?");
    expect(stripFindingLines(text, { singleFilePath: "src/demo.ts" })).toBe("plain prose without a location");
    expect(
      stripFindingLines(text, {
        posted: new Set([findingFingerprint("src/foo.ts", "🔴 bug: null deref. Guard it.")]),
      })
    ).toBe("plain prose without a location\nL12: ❓ q: is the timeout intentional?");
  });

  test("fingerprints findings by path and normalized text, not line", () => {
    expect(findingFingerprint("src/foo.ts", "🔴 bug: first.")).toBe(
      findingFingerprint("src/foo.ts", "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->")
    );
    expect(findingFingerprint("src/foo.ts", "🔴 bug: first.")).not.toBe(
      findingFingerprint("src/bar.ts", "🔴 bug: first.")
    );
  });
});
