import type { ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import type { RouterSitReason, RouterSitRecord } from "./router_sits.ts";
import { latchedXaiGrantNotice } from "./xai_auth.ts";

/**
 * Operator board read API.
 *
 * Served by the router on a second port (3001), never on the webhook host.
 * Polling GET only; no forge webhooks are pushed to the browser and no
 * per-row forge calls are made. In-progress comes from the job ledger
 * (queued or leased); sitting rows come from persisted refusals
 * (`router_sits`). The router stays a single replica; no leader election.
 */

export const BOARD_PORT = 3001;

const BOARD_PATHS = new Set(["/", "/board", "/api/board"]);

/** Ingress injects one of these; the webhook secret is never a substitute.
 * 3001 must only be reachable via that auth proxy (ingress is out of scope):
 * a direct-to-pod route would let anyone self-assert these headers. */
const EDGE_IDENTITY_HEADERS = [
  "x-forwarded-user",
  "x-forwarded-email",
  "x-auth-request-user",
  "x-remote-user",
] as const;

export function hasEdgeIdentity(request: Request): boolean {
  for (const header of EDGE_IDENTITY_HEADERS) {
    const value = request.headers.get(header);
    if (value != null && value.trim() !== "") return true;
  }
  return false;
}

export interface BoardKick {
  /** Server-provided effect text for this kick. */
  effect: string;
}

export interface BoardItem {
  /** Headline reason: ledger kind+state for in-progress, sit code for sits. */
  reason: string;
  owner: string;
  repo: string;
  /** Pull or issue number (shared number space). */
  number: number;
  /** Job kind for ledger rows; "sit" for refusal rows. */
  kind: string;
  /** Commit SHA when the ledger knows one. Omitted otherwise. */
  commit?: string;
  /** Alias of commit for clients that expect headSha. Omitted otherwise. */
  headSha?: string;
  /** Epoch ms when the sit was decided. Sits only. */
  decidedAt?: number;
  /** At most one kick. Absent when there is no button payload. */
  kick?: BoardKick;
}

export interface BoardGroups {
  in_progress: BoardItem[];
  needs_kick: BoardItem[];
  sitting: BoardItem[];
}

/** Sits with no button: already done, nothing to ship, or already queued. */
const NO_KICK_SITS = new Set<string>(["terminal-result", "no-changes", "repo-mutex"]);

const SIT_KICK_EFFECTS: Record<string, string> = {
  "ci-not-completed": "Re-check once CI finishes",
  "draft-wip": "Re-evaluate when marked ready",
  "foreign-branch": "Re-evaluate if the branch becomes local",
  "no-closer": "Re-evaluate when a closing issue is linked",
  "implement-latch": "Re-evaluate after the owning job finishes",
  "no-write-access": "Re-evaluate when the sender gains write access",
  "not-labeled": "Re-evaluate when labeled for pickup",
};

function kickForSit(reason: RouterSitReason): BoardKick | undefined {
  if (NO_KICK_SITS.has(reason)) return undefined;
  const effect = SIT_KICK_EFFECTS[reason] ?? "Re-evaluate on the next webhook";
  return { effect };
}

function primaryNumber(row: ReviewJobRecord): number {
  if (row.kind === "review") return row.prNumber;
  if (typeof row.issueNumber === "number" && Number.isFinite(row.issueNumber) && row.issueNumber !== 0) {
    return row.issueNumber;
  }
  return row.prNumber;
}

function inflightItem(row: ReviewJobRecord): BoardItem {
  const item: BoardItem = {
    reason: `${row.kind} ${row.state}`,
    owner: row.owner,
    repo: row.repo,
    number: primaryNumber(row),
    kind: row.kind,
  };
  const sha = (row.headSha ?? "").trim();
  if (sha !== "") {
    item.commit = sha;
    item.headSha = sha;
  }
  return item;
}

function sitItem(sit: RouterSitRecord): { item: BoardItem; kickable: boolean } {
  const item: BoardItem = {
    reason: sit.reason,
    owner: sit.owner,
    repo: sit.repo,
    number: sit.number,
    kind: "sit",
    decidedAt: sit.decidedAt,
  };
  const kick = kickForSit(sit.reason);
  if (kick) item.kick = kick;
  return { item, kickable: kick !== undefined };
}

export interface BoardStore {
  listInflight(limit?: number): Promise<ReviewJobRecord[]>;
  sits: { list(): Promise<RouterSitRecord[]> };
}

export async function buildBoardGroups(store: BoardStore): Promise<BoardGroups> {
  const [inflight, sits] = await Promise.all([store.listInflight(200), store.sits.list()]);
  const in_progress = inflight.map(inflightItem);
  const needs_kick: BoardItem[] = [];
  const sitting: BoardItem[] = [];
  for (const sit of sits) {
    const { item, kickable } = sitItem(sit);
    if (kickable) needs_kick.push(item);
    else sitting.push(item);
  }
  return { in_progress, needs_kick, sitting };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export interface BoardHandlerDeps {
  store: ReviewJobStore;
  getGrantNotice?: () => string | undefined;
  logger?: (message: string) => void;
}

export function createBoardFetchHandler(deps: BoardHandlerDeps) {
  const logger = deps.logger ?? ((message: string) => console.log(`[board] ${message}`));
  const getGrant = deps.getGrantNotice ?? latchedXaiGrantNotice;
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    if (!BOARD_PATHS.has(pathname)) return json(404, { error: "not found" });
    if (request.method !== "GET") return json(405, { error: "method not allowed" });
    // Edge identity only. The webhook HMAC secret and auth token are not accepted here.
    if (!hasEdgeIdentity(request)) return json(401, { error: "missing edge identity" });
    let groups: BoardGroups;
    try {
      groups = await buildBoardGroups(deps.store);
    } catch (err) {
      logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    const grant = getGrant();
    const grantLine = typeof grant === "string" && grant.trim() !== "" ? grant.split("\n")[0]?.trim() : undefined;
    const body: Record<string, unknown> = {
      in_progress: groups.in_progress,
      inProgress: [...groups.in_progress],
      needs_kick: groups.needs_kick,
      needsKick: [...groups.needs_kick],
      sitting: groups.sitting,
      sitting_on_purpose: [...groups.sitting],
    };
    if (grantLine) body.grant = grantLine;
    return json(200, body);
  };
}
