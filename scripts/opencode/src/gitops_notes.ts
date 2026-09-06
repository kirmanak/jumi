export type GitOpsNotes = { kind: "missing" } | { kind: "none" } | { kind: "items"; text: string };

export type GitOpsBumpVerdict =
  | { severity: "yellow"; reason: "no GitOps notes; cannot tell if values need edits" }
  | { severity: "none" }
  | { severity: "red"; reason: string };

const JUMI_IMAGE = /(?:^|[^A-Za-z0-9-])jumi-(?:reviewer|worker)(?:$|[^A-Za-z0-9-])/;
const IMAGE_REPO = /gitea\.kirmanak\.stream\/personal\/jumi-(?:reviewer|worker)/;

export function isJumiDockerBump(title: string, body: string): boolean {
  const blob = `${title}\n${body}`;
  if (!JUMI_IMAGE.test(blob) && !IMAGE_REPO.test(blob)) return false;
  return (
    /depName/i.test(blob) ||
    IMAGE_REPO.test(blob) ||
    /digest to /i.test(blob) ||
    /update.*(?:docker|digest|image)/i.test(blob)
  );
}

export function parseGitOpsSection(markdown: string): GitOpsNotes {
  const heading = /(^|\n)## GitOps[ \t]*\n/;
  const startMatch = heading.exec(markdown);
  if (!startMatch || startMatch.index === undefined) return { kind: "missing" };
  const start = startMatch.index + startMatch[0].length;
  const rest = markdown.slice(start);
  const next = /\n## /.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  if (!body || /^none$/i.test(body)) return { kind: "none" };
  const withoutSubheads = body
    .replace(/^###\s+\S+\s*$/gm, "")
    .replace(/^\s*-\s*none\s*$/gim, "")
    .trim();
  if (!withoutSubheads) return { kind: "none" };
  return { kind: "items", text: body };
}

export function gitOpsBumpVerdict(opts: { notes: GitOpsNotes; chartOrValuesEdited: boolean }): GitOpsBumpVerdict {
  if (opts.notes.kind === "missing") {
    return { severity: "yellow", reason: "no GitOps notes; cannot tell if values need edits" };
  }
  if (opts.notes.kind === "none") {
    return { severity: "none" };
  }
  if (!opts.chartOrValuesEdited) {
    return { severity: "red", reason: "GitOps notes require chart/values edits that are missing from the diff" };
  }
  return { severity: "none" };
}
