import type { QueryExpr } from "@takibi/takibi";
import type { CleanedWhere } from "better-auth/adapters";

const TAKIBI_QUERY_MAX_NODES = 32;
const TAKIBI_QUERY_MAX_DEPTH = 8;

export type RuntimeQueryField = {
  present(): QueryExpr;
  eq(value: string | number | boolean | null): QueryExpr;
  in(values: readonly (string | number | boolean | null)[]): QueryExpr;
  gt(value: string | number): QueryExpr;
  gte(value: string | number): QueryExpr;
  lt(value: string | number): QueryExpr;
  lte(value: string | number): QueryExpr;
  contains(value: string): QueryExpr;
  startsWith(value: string): QueryExpr;
  endsWith(value: string): QueryExpr;
};

export type RuntimeQueryBuilder = Record<string, RuntimeQueryField> & {
  and(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  or(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  not(operand: QueryExpr): QueryExpr;
};

export function selectTakibiIndex(
  indexes: Readonly<Record<string, readonly string[]>> | undefined,
  where: CleanedWhere[] | undefined,
): string | undefined {
  if (!indexes || !where) return undefined;
  const equalityFields = new Set(
    where
      .filter(
        (clause) =>
          clause.operator === "eq" &&
          clause.mode === "sensitive" &&
          clause.value !== null &&
          isTakibiScalar(toTakibiScalar(clause.value)),
      )
      .map(({ field }) => field),
  );
  return Object.entries(indexes)
    .filter(([, fields]) => fields[0] && equalityFields.has(fields[0]))
    .sort((left, right) => right[1].length - left[1].length)[0]?.[0];
}

export function compileTakibiWhere(
  where: CleanedWhere[] | undefined,
): ((query: RuntimeQueryBuilder) => QueryExpr) | undefined {
  if (!where || where.length === 0 || !where.every(canPushClause)) {
    return undefined;
  }
  const shape = estimateQueryShape(where);
  if (shape.nodes > TAKIBI_QUERY_MAX_NODES || shape.depth > TAKIBI_QUERY_MAX_DEPTH) {
    return undefined;
  }
  return (query) => {
    const expressions = where.map((clause) => compileTakibiClause(query, clause));
    let expression = expressions[0]!;
    for (let index = 1; index < expressions.length; index += 1) {
      expression =
        where[index]!.connector === "OR"
          ? query.or(expression, expressions[index]!)
          : query.and(expression, expressions[index]!);
    }
    return expression;
  };
}

export function matchesBetterAuthWhere(
  document: Readonly<Record<string, unknown>>,
  where: CleanedWhere[] | undefined,
): boolean {
  if (!where || where.length === 0) return true;
  let result = matchesClause(document, where[0]!);
  for (let index = 1; index < where.length; index += 1) {
    const clause = where[index]!;
    const matches = matchesClause(document, clause);
    result = clause.connector === "OR" ? result || matches : result && matches;
  }
  return result;
}

export function compareBetterAuthValues(
  left: unknown,
  right: unknown,
  direction: "asc" | "desc",
): number {
  let result: number;
  if (left == null && right == null) result = 0;
  else if (left == null) result = -1;
  else if (right == null) result = 1;
  else if (typeof left === "string" && typeof right === "string") {
    result = left.localeCompare(right);
  } else if (typeof left === "number" && typeof right === "number") {
    result = left - right;
  } else if (typeof left === "boolean" && typeof right === "boolean") {
    result = left === right ? 0 : left ? 1 : -1;
  } else {
    result = 0;
  }
  return direction === "asc" ? result : -result;
}

function estimateQueryShape(where: CleanedWhere[]): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  for (const clause of where) {
    const leaf =
      clause.operator === "eq" && clause.value === null
        ? { nodes: 4, depth: 3 }
        : clause.operator === "ne" && clause.value === null
          ? { nodes: 5, depth: 4 }
          : clause.operator === "ne" || clause.operator === "not_in"
            ? { nodes: 2, depth: 2 }
            : { nodes: 1, depth: 1 };
    nodes += leaf.nodes + (depth === 0 ? 0 : 1);
    depth = depth === 0 ? leaf.depth : Math.max(depth, leaf.depth) + 1;
  }
  return { nodes, depth };
}

function canPushClause(clause: CleanedWhere): boolean {
  if (clause.mode === "insensitive") return false;
  if (clause.operator === "in" || clause.operator === "not_in") {
    return (
      Array.isArray(clause.value) &&
      clause.value.length > 0 &&
      clause.value.length <= TAKIBI_QUERY_MAX_NODES &&
      clause.value.every((value) => isTakibiScalar(toTakibiScalar(value)))
    );
  }
  const value = toTakibiScalar(clause.value);
  switch (clause.operator) {
    case "eq":
    case "ne":
      return isTakibiScalar(value);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return typeof value === "string" || typeof value === "number";
    case "contains":
    case "starts_with":
    case "ends_with":
      return typeof value === "string";
    default:
      return false;
  }
}

function compileTakibiClause(query: RuntimeQueryBuilder, clause: CleanedWhere): QueryExpr {
  const field = query[clause.field]!;
  const value = toTakibiScalar(clause.value);
  if (clause.operator === "in" || clause.operator === "not_in") {
    const values = (clause.value as unknown[]).map(toTakibiScalar) as Array<
      string | number | boolean | null
    >;
    const expression = field.in(values);
    return clause.operator === "not_in" ? query.not(expression) : expression;
  }
  if (clause.operator === "eq" || clause.operator === "ne") {
    const equality =
      value === null
        ? query.or(field.eq(null), query.not(field.present()))
        : field.eq(value as string | number | boolean);
    return clause.operator === "ne" ? query.not(equality) : equality;
  }
  const comparable = value as string | number;
  switch (clause.operator) {
    case "gt":
      return field.gt(comparable);
    case "gte":
      return field.gte(comparable);
    case "lt":
      return field.lt(comparable);
    case "lte":
      return field.lte(comparable);
    case "contains":
      return field.contains(comparable as string);
    case "starts_with":
      return field.startsWith(comparable as string);
    case "ends_with":
      return field.endsWith(comparable as string);
    default:
      throw new TypeError("Unsupported Takibi query operator");
  }
}

function toTakibiScalar(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function isTakibiScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function matchesClause(document: Readonly<Record<string, unknown>>, clause: CleanedWhere): boolean {
  const actual = document[clause.field];
  const expected = Array.isArray(clause.value)
    ? clause.value.map(toTakibiScalar)
    : toTakibiScalar(clause.value);
  const insensitive =
    clause.mode === "insensitive" &&
    (typeof expected === "string" ||
      (Array.isArray(expected) && expected.every((value) => typeof value === "string")));
  const equal = (left: unknown, right: unknown) =>
    right === null
      ? left === null || left === undefined
      : insensitive && typeof left === "string" && typeof right === "string"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;

  switch (clause.operator) {
    case "eq":
      return expected === null ? actual == null : equal(actual, expected);
    case "ne":
      return !equal(actual, expected);
    case "in":
      return Array.isArray(expected) && expected.some((value) => equal(actual, value));
    case "not_in":
      return Array.isArray(expected) && !expected.some((value) => equal(actual, value));
    case "contains":
      return stringMatch(actual, expected, insensitive, (value, search) => value.includes(search));
    case "starts_with":
      return stringMatch(actual, expected, insensitive, (value, search) =>
        value.startsWith(search),
      );
    case "ends_with":
      return stringMatch(actual, expected, insensitive, (value, search) => value.endsWith(search));
    case "gt":
      return compareComparable(actual, expected) > 0;
    case "gte":
      return compareComparable(actual, expected) >= 0;
    case "lt":
      return compareComparable(actual, expected) < 0;
    case "lte":
      return compareComparable(actual, expected) <= 0;
  }
}

function stringMatch(
  actual: unknown,
  expected: unknown,
  insensitive: boolean,
  compare: (actual: string, expected: string) => boolean,
): boolean {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  return insensitive
    ? compare(actual.toLowerCase(), expected.toLowerCase())
    : compare(actual, expected);
}

function compareComparable(actual: unknown, expected: unknown): number {
  if (
    (typeof actual !== "string" && typeof actual !== "number") ||
    typeof actual !== typeof expected
  ) {
    return Number.NaN;
  }
  if (actual === expected) return 0;
  if (typeof actual === "string" && typeof expected === "string") {
    return actual > expected ? 1 : -1;
  }
  if (typeof actual === "number" && typeof expected === "number") {
    return actual > expected ? 1 : -1;
  }
  return Number.NaN;
}
