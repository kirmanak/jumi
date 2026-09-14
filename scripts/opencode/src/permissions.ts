import type { CollaboratorPermission } from "./ports.ts";

export type { CollaboratorPermission };

export type PermissionApi = Pick<
  { getCollaboratorPermission(owner: string, repo: string, username: string): Promise<CollaboratorPermission> },
  "getCollaboratorPermission"
>;

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
