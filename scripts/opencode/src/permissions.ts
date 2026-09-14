/** Write-or-stronger permission bar shared by review ingest and follow-up wake. */

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

/** Single-login check. Fail-closed if the forge cannot say they have write. */
export async function hasWriteAccess(
  api: CollaboratorPermissionApi,
  owner: string,
  repo: string,
  login: string | undefined | null
): Promise<boolean> {
  const key = loginKey(login);
  if (!key) return false;
  const fn = api.getCollaboratorPermission;
  if (typeof fn !== "function") return false;
  try {
    const result = await fn.call(api, owner, repo, login as string);
    return isWritePermission(permissionFromResult(result));
  } catch {
    return false;
  }
}

/** Raw permission string per login, lowercased. Fail-closed entries are `"none"`. */
export async function resolvePermissions(
  api: CollaboratorPermissionApi,
  owner: string,
  repo: string,
  logins: Iterable<string | undefined | null>
): Promise<Map<string, string>> {
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
    return out;
  }
  await Promise.all(
    [...distinct.entries()].map(async ([key, login]) => {
      try {
        const result = await fn.call(api, owner, repo, login);
        out.set(key, normalizePermission(permissionFromResult(result)));
      } catch {
        out.set(key, "none");
      }
    })
  );
  return out;
}

/** Write-access boolean per lowercased login. Fail-closed on any forge error. */
export async function resolveWriteAccess(
  api: CollaboratorPermissionApi,
  owner: string,
  repo: string,
  logins: Iterable<string | undefined | null>
): Promise<Map<string, boolean>> {
  const permissions = await resolvePermissions(api, owner, repo, logins);
  const out = new Map<string, boolean>();
  for (const [key, permission] of permissions) {
    out.set(key, isWritePermission(permission));
  }
  return out;
}

export function hasWriteForLogin(
  permissions: ReadonlyMap<string, boolean> | undefined,
  login: string | undefined | null
): boolean {
  const key = loginKey(login);
  if (!key) return false;
  return permissions?.get(key) === true;
}
