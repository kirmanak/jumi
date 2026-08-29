import type { GiteaCommitStatusState } from "./types.ts";

export interface ReviewVerdict {
  state: Extract<GiteaCommitStatusState, "success" | "failure">;
  description: string;
  incomplete: boolean;
}

export interface ParsedReviewOutput {
  comment: string;
  verdict: ReviewVerdict;
}

const CHECK_LINE_RE = /^<!--\s*jumi-check:\s*(success|failure)(?:\s*;\s*([^>]*?))?\s*-->$/i;

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function parseCheckLine(line: string): { state: "success" | "failure"; reason: string } | undefined {
  const match = CHECK_LINE_RE.exec(line);
  if (!match) return undefined;
  return {
    state: match[1].toLowerCase() === "success" ? "success" : "failure",
    reason: (match[2] ?? "").trim(),
  };
}

function stripCheckComments(text: string): string {
  return text
    .replace(/<!--\s*jumi-check:\s*(?:success|failure)(?:\s*;\s*[^>]*?)?\s*-->/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseReviewOutput(output: string): ParsedReviewOutput {
  const text = output.trim();
  if (!text) {
    return {
      comment: "",
      verdict: { state: "failure", description: "Incomplete review: no output", incomplete: true },
    };
  }

  const check = parseCheckLine(lastNonEmptyLine(text));
  const comment = stripCheckComments(text);
  if (!check) {
    return {
      comment,
      verdict: { state: "failure", description: "Incomplete review: no check verdict", incomplete: true },
    };
  }

  const description = check.reason || (check.state === "success" ? "No blocking issues" : "Review requested changes");
  return {
    comment,
    verdict: { state: check.state, description, incomplete: false },
  };
}
