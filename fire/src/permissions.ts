export const READ = Symbol("fire.READ");
export const CREATE = Symbol("fire.CREATE");
export const UPDATE = Symbol("fire.UPDATE");
export const DELETE = Symbol("fire.DELETE");
/** CREATE + UPDATE + DELETE */
export const EDIT = Symbol("fire.EDIT");
export const ALL = Symbol("fire.ALL");

export type Permission =
  | typeof READ
  | typeof CREATE
  | typeof UPDATE
  | typeof DELETE
  | typeof EDIT
  | typeof ALL;

export type AccessGrant = Permission | readonly Permission[] | false | null | undefined;

const WRITE_OPS = new Set([CREATE, UPDATE, DELETE, EDIT, ALL]);

export function expandPermissions(grant: AccessGrant): Set<Permission> {
  const out = new Set<Permission>();
  if (grant == null || grant === false) return out;

  const list = Array.isArray(grant) ? grant : [grant];
  for (const p of list) {
    if (p === ALL) {
      out.add(READ);
      out.add(CREATE);
      out.add(UPDATE);
      out.add(DELETE);
      continue;
    }
    if (p === EDIT) {
      out.add(CREATE);
      out.add(UPDATE);
      out.add(DELETE);
      continue;
    }
    out.add(p);
  }
  return out;
}

export function allows(grant: AccessGrant, needed: Permission): boolean {
  const perms = expandPermissions(grant);
  if (needed === EDIT) {
    return perms.has(CREATE) && perms.has(UPDATE) && perms.has(DELETE);
  }
  if (needed === ALL) {
    return perms.has(READ) && perms.has(CREATE) && perms.has(UPDATE) && perms.has(DELETE);
  }
  return perms.has(needed) || (WRITE_OPS.has(needed) && perms.has(EDIT)) || perms.has(ALL);
}
