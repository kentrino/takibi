import { grant, none, write } from "./policy";
import type { AccessContext, AccessGrant, AccessPolicyFn, WithMetadata } from "./types";

export type OwnedByOptions<TCtx = unknown> = {
  subject: (
    ctx: AccessContext<TCtx, WithMetadata<Record<string, unknown>>>,
  ) => string | null | undefined;
  bypass?: (ctx: AccessContext<TCtx, WithMetadata<Record<string, unknown>>>) => boolean | undefined;
};

type OwnedDoc<TField extends string> = WithMetadata<Record<string, unknown>> &
  Record<TField, string>;

/** Owner-matched docs may be written; collection list stays denied unless `bypass`. */
const ownerGrant = grant("get", "create", "update", "delete");

function createOwnedByPolicy<TCtx, TField extends string>(
  options: OwnedByOptions<TCtx> & { field: TField },
): AccessPolicyFn<TCtx, OwnedDoc<TField>> {
  const field = options.field;

  return (ctx): AccessGrant => {
    const base = ctx as AccessContext<TCtx, WithMetadata<Record<string, unknown>>>;
    if (options.bypass?.(base)) return write;

    const subject = options.subject(base);
    if (typeof subject !== "string" || subject.length === 0) return none;

    const ownerOf = (doc: OwnedDoc<TField> | undefined): string | null => {
      if (!doc) return null;
      const value = doc[field];
      return typeof value === "string" && value.length > 0 ? value : null;
    };

    switch (ctx.operation) {
      case "list":
        return none;
      case "add":
        return ownerOf(ctx.nextDoc) === subject ? ownerGrant : none;
      case "get":
      case "delete":
        return ownerOf(ctx.doc) === subject ? ownerGrant : none;
      case "update":
        return ownerOf(ctx.doc) === subject && ownerOf(ctx.nextDoc) === subject ? ownerGrant : none;
      case "set":
        if (ctx.doc !== undefined) {
          return ownerOf(ctx.doc) === subject && ownerOf(ctx.nextDoc) === subject
            ? ownerGrant
            : none;
        }
        return ownerOf(ctx.nextDoc) === subject ? ownerGrant : none;
      default: {
        const _exhaustive: never = ctx.operation;
        return _exhaustive;
      }
    }
  };
}

/**
 * Owner-scoped `accessPolicy` helper.
 *
 * - add / new set: `nextDoc[field]` must equal `subject`
 * - get / delete: `doc[field]` must equal `subject`
 * - update / existing set: both `doc[field]` and `nextDoc[field]` must equal `subject`
 * - list: denied unless `bypass` is true
 *
 * Matching requests receive get/create/update/delete (not list). Does not insert owner values;
 * clients must supply them. Trusted storage bypasses this policy.
 * With `defineResource` / `ResourceDefinition`, assigning to a schema that lacks `field`
 * (default `"ownerId"`) is a type error.
 */
export function ownedBy<TCtx = unknown>(
  options: OwnedByOptions<TCtx> & { field?: "ownerId" },
): AccessPolicyFn<TCtx, OwnedDoc<"ownerId">>;
export function ownedBy<TCtx = unknown, const TField extends string = string>(
  options: OwnedByOptions<TCtx> & { field: TField },
): AccessPolicyFn<TCtx, OwnedDoc<TField>>;
export function ownedBy<TCtx = unknown, TField extends string = "ownerId">(
  options: OwnedByOptions<TCtx> & { field?: TField },
): AccessPolicyFn<TCtx, OwnedDoc<TField>> {
  return createOwnedByPolicy({
    ...options,
    field: (options.field ?? "ownerId") as TField,
  });
}
