import { normalizeServerQueryExpr } from "@takibi/protocol";
import type { ListWhereScope, QueryBuilder, QueryExpr } from "@takibi/shared-types";
import { compileWhere } from "./query";

/** Safe to expose even when a scope callback throws sensitive values. */
export class ListScopeError extends Error {
  constructor() {
    super("Invalid list authorization scope");
    this.name = "ListScopeError";
  }
}

const scopes = new WeakSet<object>();

export function listWhere<TDoc>(
  callback: (query: QueryBuilder<TDoc>) => QueryExpr,
): ListWhereScope {
  try {
    const scope = Object.freeze({
      kind: "listWhere",
      where: compileWhere(callback),
    }) as ListWhereScope;
    scopes.add(scope);
    return scope;
  } catch {
    throw new ListScopeError();
  }
}

export function isListWhereScope(value: unknown): value is ListWhereScope {
  return typeof value === "object" && value !== null && scopes.has(value);
}

function compose(op: "and" | "or", operands: readonly QueryExpr[]): QueryExpr {
  try {
    if (operands.length === 0) throw new ListScopeError();
    const result = normalizeServerQueryExpr(operands.length === 1 ? operands[0] : { op, operands });
    // Inputs are already normalized; preserve the accepted singleton identity.
    return operands.length === 1 && Object.isFrozen(operands[0]) ? operands[0]! : result;
  } catch {
    throw new ListScopeError();
  }
}

export function composeAnd(...operands: QueryExpr[]): QueryExpr {
  return compose("and", operands);
}

export function composeOr(...operands: QueryExpr[]): QueryExpr {
  return compose("or", operands);
}
