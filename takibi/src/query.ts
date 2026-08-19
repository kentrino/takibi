import type {
  ListOptions,
  QueryBuilder,
  QueryExpr,
  QueryOperator,
  QueryScalar,
  StorageListOptions,
} from "./types";
import { TAKIBI_VERSION_KEY } from "./types";

export const QUERY_MAX_NODES = 32;
export const QUERY_MAX_DEPTH = 8;

const LEAF_OPERATORS = new Set<QueryOperator>(["eq", "gt", "gte", "lt", "lte"]);

export function compileListOptions<TDoc>(
  options: ListOptions<TDoc> | undefined,
): StorageListOptions | undefined {
  if (!options) return undefined;
  const compiled: StorageListOptions = {
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.where !== undefined ? { where: compileWhere(options.where) } : {}),
  };
  return Object.keys(compiled).length === 0 ? undefined : compiled;
}

export function compileWhere<TDoc>(callback: (query: QueryBuilder<TDoc>) => QueryExpr): QueryExpr {
  if (typeof callback !== "function") {
    throw new TypeError("where must be a query builder callback");
  }

  const expressions = new WeakSet<object>();
  const query = createQueryBuilder<TDoc>(expressions);
  const result = callback(query);
  if (!isRecord(result) || !expressions.has(result)) {
    throw new TypeError("where callback must return an expression created by its query builder");
  }
  return normalizeQueryExpr(result);
}

function createQueryBuilder<TDoc>(expressions: WeakSet<object>): QueryBuilder<TDoc> {
  const fields = new Map<string, object>();

  const assertExpression: (value: unknown) => asserts value is QueryExpr = (
    value,
  ): asserts value is QueryExpr => {
    if (!isRecord(value) || !expressions.has(value)) {
      throw new TypeError("Query operands must be created by the current query builder");
    }
  };

  const register = <T extends QueryExpr>(expression: T): T => {
    const frozen = Object.freeze(expression);
    expressions.add(frozen);
    return frozen;
  };

  const fieldMethods = (field: string) => {
    let methods = fields.get(field);
    if (methods) return methods;

    const leaf = (op: QueryOperator, value: unknown): QueryExpr => {
      assertQueryValue(op, value);
      return register({ field, op, value });
    };
    methods = Object.freeze({
      eq: (value: unknown) => leaf("eq", value),
      gt: (value: unknown) => leaf("gt", value),
      gte: (value: unknown) => leaf("gte", value),
      lt: (value: unknown) => leaf("lt", value),
      lte: (value: unknown) => leaf("lte", value),
    });
    fields.set(field, methods);
    return methods;
  };

  const and = (first: unknown, second: unknown, ...rest: unknown[]): QueryExpr => {
    const operands = [first, second, ...rest].map((operand) => {
      assertExpression(operand);
      return operand;
    });
    return register({ op: "and", operands: Object.freeze(operands) });
  };
  const or = (first: unknown, second: unknown, ...rest: unknown[]): QueryExpr => {
    const operands = [first, second, ...rest].map((operand) => {
      assertExpression(operand);
      return operand;
    });
    return register({ op: "or", operands: Object.freeze(operands) });
  };
  const not = (operand: unknown): QueryExpr => {
    assertExpression(operand);
    return register({ op: "not", operand });
  };

  const booleanMethods = new Map<string, object>([
    ["and", Object.freeze(Object.assign(and, fieldMethods("and")))],
    ["or", Object.freeze(Object.assign(or, fieldMethods("or")))],
    ["not", Object.freeze(Object.assign(not, fieldMethods("not")))],
  ]);

  return new Proxy(Object.create(null) as QueryBuilder<TDoc>, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") return undefined;
      return booleanMethods.get(property) ?? fieldMethods(property);
    },
  });
}

export function normalizeQueryExpr(value: unknown): QueryExpr {
  const seen = new Set<object>();
  const budget = { nodes: 0 };

  const visit = (input: unknown, depth: number): QueryExpr => {
    if (depth > QUERY_MAX_DEPTH) {
      throw new TypeError(`Query depth must not exceed ${QUERY_MAX_DEPTH}`);
    }
    if (!isRecord(input)) throw new TypeError("Query expression must be an object");
    if (seen.has(input)) throw new TypeError("Query expression must not be cyclic");
    seen.add(input);

    budget.nodes += 1;
    if (budget.nodes > QUERY_MAX_NODES) {
      throw new TypeError(`Query must not exceed ${QUERY_MAX_NODES} nodes`);
    }

    const op = input.op;
    let normalized: QueryExpr;
    if (typeof op === "string" && LEAF_OPERATORS.has(op as QueryOperator)) {
      assertExactKeys(input, ["field", "op", "value"]);
      if (typeof input.field !== "string" || input.field.length === 0) {
        throw new TypeError("Query field must be a non-empty string");
      }
      if (input.field === TAKIBI_VERSION_KEY) {
        throw new TypeError(`${TAKIBI_VERSION_KEY} is reserved and cannot be queried`);
      }
      assertQueryValue(op as QueryOperator, input.value);
      normalized = Object.freeze({
        field: input.field,
        op: op as QueryOperator,
        value: input.value,
      });
    } else if (op === "and" || op === "or") {
      assertExactKeys(input, ["op", "operands"]);
      if (!Array.isArray(input.operands) || input.operands.length < 2) {
        throw new TypeError(`${op} requires at least two operands`);
      }
      normalized = Object.freeze({
        op,
        operands: Object.freeze(input.operands.map((operand) => visit(operand, depth + 1))),
      });
    } else if (op === "not") {
      assertExactKeys(input, ["op", "operand"]);
      normalized = Object.freeze({ op, operand: visit(input.operand, depth + 1) });
    } else {
      throw new TypeError("Unknown query operator");
    }

    seen.delete(input);
    return normalized;
  };

  return visit(value, 1);
}

export function matchesQuery(
  document: Readonly<Record<string, unknown>>,
  expression: QueryExpr,
): boolean {
  if ("field" in expression) {
    if (!Object.prototype.hasOwnProperty.call(document, expression.field)) return false;
    const actual = document[expression.field];
    if (actual === null || expression.value === null) {
      return expression.op === "eq" && actual === expression.value;
    }
    if (typeof actual !== typeof expression.value) return false;
    if (
      (typeof actual !== "string" && typeof actual !== "number" && typeof actual !== "boolean") ||
      (typeof expression.value !== "string" &&
        typeof expression.value !== "number" &&
        typeof expression.value !== "boolean")
    ) {
      return false;
    }

    switch (expression.op) {
      case "eq":
        return actual === expression.value;
      case "gt":
        return (
          (typeof actual === "string" && actual > (expression.value as string)) ||
          (typeof actual === "number" && actual > (expression.value as number))
        );
      case "gte":
        return (
          (typeof actual === "string" && actual >= (expression.value as string)) ||
          (typeof actual === "number" && actual >= (expression.value as number))
        );
      case "lt":
        return (
          (typeof actual === "string" && actual < (expression.value as string)) ||
          (typeof actual === "number" && actual < (expression.value as number))
        );
      case "lte":
        return (
          (typeof actual === "string" && actual <= (expression.value as string)) ||
          (typeof actual === "number" && actual <= (expression.value as number))
        );
    }
  }

  if (expression.op === "not") return !matchesQuery(document, expression.operand);
  return expression.op === "and"
    ? expression.operands.every((operand) => matchesQuery(document, operand))
    : expression.operands.some((operand) => matchesQuery(document, operand));
}

export function queryImpliesEquality(
  expression: QueryExpr | undefined,
  field: string,
  value: QueryScalar,
): boolean {
  if (!expression) return false;
  if ("field" in expression) {
    return expression.field === field && expression.op === "eq" && expression.value === value;
  }
  if (expression.op === "and") {
    return expression.operands.some((operand) => queryImpliesEquality(operand, field, value));
  }
  if (expression.op === "or") {
    return expression.operands.every((operand) => queryImpliesEquality(operand, field, value));
  }
  return false;
}

function assertQueryValue(op: QueryOperator, value: unknown): asserts value is QueryScalar {
  const scalar =
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
  if (!scalar) throw new TypeError("Query value must be a JSON scalar with finite numbers");
  if (op !== "eq" && typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`${op} requires a string or finite number`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new TypeError("Query expression has unexpected fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
