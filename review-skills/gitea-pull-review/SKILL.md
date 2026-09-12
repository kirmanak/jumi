---
name: gitea-pull-review
description: Use when implementing Gitea pull-review create/list/submit or inline comments (pending reviews, commit_id vs current head, submit vs issue comments). This forge is Gitea 1.27. Do not webfetch go-gitea/main or GitHub review docs.
---

# gitea-pull-review

This instance runs **Gitea 1.27** (`/api/v1/version` → `1.27.3`). Pin to that. Do not webfetch `raw.githubusercontent.com/go-gitea/gitea/main` (`pull_review.go`, convert, routers) or GitHub's review API.

Load this skill via the skill tool.

Base: `POST|GET /api/v1/repos/{owner}/{repo}/pulls/{index}/reviews`

## Create

`POST .../pulls/{index}/reviews`

Body (`CreatePullReviewOptions`):

```json
{
  "body": "summary",
  "commit_id": "<current pull.head.sha>",
  "event": "PENDING",
  "comments": [
    { "path": "src/foo.ts", "body": "inline", "new_position": 12, "old_position": 0 }
  ]
}
```

- `event`: set explicitly. `PENDING` keeps a draft. `COMMENT` publishes. Do not omit.
- Inline comments go in `comments` at **create** time. 1.27 has **no** `POST .../reviews/{id}/comments` and **no** `POST .../pulls/{index}/comments` for a new thread.
- Create comment fields are `body`, `path`, `new_position` (new-file line, or 0), `old_position` (old-file line, or 0). Not GitHub `line` / `side` / `start_line` / `subject_type`.

## `commit_id` vs current head

- Set `commit_id` to the PR's **current** `head.sha`.
- Omit only if you mean “head at create time”; empty is filled with head. Do not pass a file blob SHA, base SHA, or an older review SHA.
- A SHA that is not the current head is not a `422`; create succeeds with `stale: false`.
- After HEAD moves, a pending review's `commit_id` stays the old SHA and `stale` is true. Submit (`POST .../reviews/{id}`) rewrites `commit_id` to current head.

## List / get

- `GET .../pulls/{index}/reviews?limit=50&page=1` — array of `PullReview`. Page while length is exactly 50.
- `GET .../pulls/{index}/reviews/{id}` — one review.
- `GET .../pulls/{index}/reviews/{id}/comments` — that review's inline comments. Nested per review; there is **no** `GET .../pulls/{index}/comments`.
- List includes the author's `PENDING` reviews. There is no nested `comments` array on the review object.

## Submit pending

`POST .../pulls/{index}/reviews/{id}`

```json
{ "body": "summary", "event": "COMMENT" }
```

That publishes the pending review. Not GitHub `.../reviews/{id}/events`. Do not submit with `event: PENDING`.

## Submit vs comments

| Intent | 1.27 |
| --- | --- |
| Conversation (not inline) | `POST .../issues/{index}/comments` `{ "body" }` — not a review |
| Published review ± inlines | `POST .../reviews` with `event: COMMENT` and `comments` |
| Draft then publish | `POST .../reviews` `event: PENDING` + comments, then `POST .../reviews/{id}` `event: COMMENT` |
| Reply to an inline | `POST .../pulls/{index}/comments/{id}/replies` `{ "body" }` |

Do not copy GitHub: create pending → POST review comments → POST events.

## What 1.27 returns

`PullReview`: `id`, `user`, `body`, `commit_id`, `state`, `html_url`, `pull_request_url`, `comments_count`, `official`, `stale`, `dismissed`, `submitted_at`, `updated_at`, optional `team`.

`state`: `PENDING` | `COMMENT` | `APPROVED` | `REQUEST_CHANGES` | `REQUEST_REVIEW`. REST uses `state`, not `status`. No `content` / `type` on the REST object (webhooks may send `type`).

`PullReviewComment`: `id`, `body`, `path`, `commit_id`, `original_commit_id`, `position` (new line), `original_position` (old line), `diff_hunk`, `pull_request_review_id`, `html_url`, `pull_request_url`, `user`, `created_at`, `updated_at`, optional `resolver`. Read uses `position` / `original_position`, not the create names `new_position` / `old_position`.

Create/submit success is `200` + that object. Missing PR/review: `404`. `PENDING` requires a non-empty `body` (even when `comments` is set). `COMMENT` with no body and no comments, or submit `event: PENDING`: `422`.

## Do not

- Webfetch `go-gitea/gitea` main or GitHub pull-review docs to guess this API.
- Add MCP.
- Treat `REQUEST_CHANGES` / `APPROVED` as in-scope for this skill (create/list/submit pending and `COMMENT` only).
