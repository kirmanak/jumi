import type { CollaboratorPermission } from "./ports.ts";

export type { CollaboratorPermission };

export type PermissionApi = Pick<
  { getCollaboratorPermission(owner: string, repo: string, username: string): Promise<CollaboratorPermission> },
  "getCollaboratorPermission"
>;

/** Write-or-stronger permission bar for review ingest. */

export type CollaboratorPermissionResult = {
  permission: string;
  roleName?: string;
};

export type CollaboratorPermissionApi = {
  getCollaboratorPermission?: (
    owner: string,
    repo: string,
    login: string
  ) => Promise<CollaboratorPermissionResult | string>;
};

/**
 * Same write-or-stronger bar for people and Apps.
 * Gitea reports `admin` / `write` / `read`.
 * GitHub reports `admin` / `maintain` / `write` / `triage` / `read`.
 * Fail-closed: anything else (including triage/read/none/unknown) is not write.
 */
export function isWritePermission(permission: string | undefined | null): boolean {
  if (typeof permission !== "string") return false;
  const normalized = permission.trim().toLowerCase();
  return normalized === "admin" || normalized === "write" || normalized === "maintain" || normalized === "owner";
}

export function normalizePermission(permission: string | undefined | null): string {
  if (typeof permission !== "string" || !permission.trim()) return "none";
  return permission.trim().toLowerCase();
}

function loginKey(login: string | undefined | null): string | undefined {
  if (typeof login !== "string") return undefined;
  const trimmed = login.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

function permissionFromResult(result: CollaboratorPermissionResult | string | undefined | null): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  if (typeof result.permission === "string") return result.permission;
  if (typeof result.roleName === "string") return result.roleName;
  return undefined;
}

export interface ResolvePermissionsResult {
  /** Raw forge permission per lowercased login, fail-closed `"none"` on any lookup failure. */
  detail: Map<string, string>;
  /** Distinct logins queried. */
  lookups: number;
  /** Lookups that failed (including unavailable API); detail holds `"none"` for each. */
  failures: number;
  /** First forge error message (truncated), for server-side warning logs. Not for the prompt. */
  sampleError?: string;
}

/**
 * Raw permission strings per login, lowercased. Fail-closed entries are `"none"`.
 * Counts per-login failures so callers can warn when a systemic forge denial
 * demotes every writer to discussion instead of looking like a thread with no writers.
 */
export async function resolvePermissions(
  api: CollaboratorPermissionApi,
  owner: string,
  repo: string,
  logins: Iterable<string | undefined | null>
): Promise<ResolvePermissionsResult> {
  const distinct = new Map<string, string>();
  for (const login of logins) {
    const key = loginKey(login);
    if (!key) continue;
    if (!distinct.has(key) && typeof login === "string" && login.trim()) {
      distinct.set(key, login.trim());
    }
  }
  const out = new Map<string, string>();
  const fn = typeof api.getCollaboratorPermission === "function" ? api.getCollaboratorPermission : undefined;
  if (!fn) {
    for (const key of distinct.keys()) out.set(key, "none");
    return {
      detail: out,
      lookups: distinct.size,
      failures: distinct.size,
      ...(distinct.size > 0 ? { sampleError: "collaborator permission API unavailable" } : {}),
    };
  }
  const errors: string[] = [];
  await Promise.all(
    [...distinct.entries()].map(async ([key, login]) => {
      try {
        const result = await fn.call(api, owner, repo, login);
        out.set(key, normalizePermission(permissionFromResult(result)));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        out.set(key, "none");
      }
    })
  );
  return {
    detail: out,
    lookups: distinct.size,
    failures: errors.length,
    ...(errors.length > 0 && errors[0] ? { sampleError: errors[0].slice(0, 240) } : {}),
  };
}

const WRITE_PERMISSIONS = new Set(["write", "admin", "owner"]);
const WRITE_ROLE_NAMES = new Set(["write", "admin", "owner", "maintain", "push"]);

export function hasWritePermission(permission: string | undefined, roleName?: string | undefined): boolean {
  const perm = (permission ?? "").toLowerCase();
  if (WRITE_PERMISSIONS.has(perm)) return true;
  const role = (roleName ?? "").toLowerCase();
  if (WRITE_ROLE_NAMES.has(role)) return true;
  return false;
}

export function hasWriteAccessFromPermission(info: CollaboratorPermission | undefined): boolean {
  if (!info) return false;
  return hasWritePermission(info.permission, info.role_name);
}

/**
 * Fail-closed write check: returns true only when the forge positively reports
 * write (or maintain/admin/owner) for the login. Any lookup failure, missing
 * method, or unknown permission is false.
 */
export async function hasWriteAccess(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  login: string | undefined
): Promise<boolean> {
  if (!api || typeof api.getCollaboratorPermission !== "function") return false;
  if (typeof login !== "string" || !login.trim()) return false;
  try {
    const info = await api.getCollaboratorPermission(owner, repo, login);
    return hasWriteAccessFromPermission(info);
  } catch {
    return false;
  }
}

/**
 * Batch write check with per-round caching. Fail-closed: logins that cannot
 * be confirmed as writers are absent from the returned set.
 */
export async function trustedWriteLogins(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  logins: readonly (string | undefined)[]
): Promise<Set<string>> {
  const trusted = new Set<string>();
  const seen = new Set<string>();
  const pending: Array<Promise<void>> = [];
  for (const raw of logins) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(
      (async () => {
        if (await hasWriteAccess(api, owner, repo, raw)) trusted.add(key);
      })()
    );
  }
  await Promise.all(pending);
  return trusted;
}
