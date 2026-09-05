export interface AssigneeLike {
  login?: string;
  username?: string;
}

export interface IssueAssignees {
  assignee?: AssigneeLike | null;
  assignees?: AssigneeLike[] | null;
}

function loginOf(user: AssigneeLike | null | undefined): string | undefined {
  const value = user?.login ?? user?.username;
  return value?.toLowerCase();
}

export function isAssignedToBot(issue: IssueAssignees, botUsername: string): boolean {
  const bot = botUsername.toLowerCase();
  if (loginOf(issue.assignee) === bot) return true;
  return (issue.assignees ?? []).some((assignee) => loginOf(assignee) === bot);
}

export function isPullRequestIssue(issue: { pull_request?: unknown }): boolean {
  return issue.pull_request != null;
}
