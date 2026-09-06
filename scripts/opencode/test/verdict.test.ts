import { describe, expect, test } from "bun:test";
import { parseReviewOutput } from "../src/verdict.ts";

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
