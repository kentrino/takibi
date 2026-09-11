import type {
  OrderExpr,
  QueryExpr,
  QueryScalar,
  QueryStringOperator,
  QueryValueOperator,
} from "@takibi/shared-types";
import { TakibiProtocolError } from "./error";

export const QUERY_MAX_NODES = 32;
export const QUERY_MAX_DEPTH = 8;

const VALUE_OPERATORS = new Set<QueryValueOperator>(["eq", "gt", "gte", "lt", "lte"]);
const STRING_OPERATORS = new Set<QueryStringOperator>(["contains", "startsWith", "endsWith"]);
const RESERVED_QUERY_FIELDS = new Set(["$schemaVersion", "rev"]);

export function parseQueryExpr(source: string): QueryExpr {
  return normalizeQueryExpr(parseJson(source, "query expression"));
}

export function parseOrderBy(source: string): OrderExpr {
  return normalizeOrderBy(parseJson(source, "order expression"));
}

export function normalizeOrderBy(value: unknown): OrderExpr {
  if (!isRecord(value)) throw new TakibiProtocolError("Order expression must be an object");
  assertExactKeys(value, ["field", "direction"]);
  if (typeof value.field !== "string" || value.field.length === 0) {
    throw new TakibiProtocolError("Order field must be a non-empty string");
  }
  if (value.direction !== "asc" && value.direction !== "desc") {
    throw new TakibiProtocolError("Order direction must be asc or desc");
  }
  return Object.freeze({ field: value.field, direction: value.direction });
}

export function normalizeQueryExpr(value: unknown): QueryExpr {
  const seen = new Set<object>();
  const budget = { nodes: 0 };

  const visit = (input: unknown, depth: number): QueryExpr => {
    if (depth > QUERY_MAX_DEPTH) {
      throw new TakibiProtocolError(`Query depth must not exceed ${QUERY_MAX_DEPTH}`);
    }
    if (!isRecord(input)) {
      throw new TakibiProtocolError("Query expression must be an object");
    }
    if (seen.has(input)) {
      throw new TakibiProtocolError("Query expression must not be cyclic");
    }
    seen.add(input);

    budget.nodes += 1;
    if (budget.nodes > QUERY_MAX_NODES) {
      throw new TakibiProtocolError(`Query must not exceed ${QUERY_MAX_NODES} nodes`);
    }

    const op = input.op;
    let normalized: QueryExpr;
    if (op === "present") {
      assertExactKeys(input, ["field", "op"]);
      assertQueryableField(input.field);
      normalized = Object.freeze({ field: input.field, op });
    } else if (op === "in") {
      assertExactKeys(input, ["field", "op", "values"]);
      assertQueryableField(input.field);
      normalized = Object.freeze({
        field: input.field,
        op,
        values: normalizeInValues(input.values),
      });
    } else if (typeof op === "string" && STRING_OPERATORS.has(op as QueryStringOperator)) {
      assertExactKeys(input, ["field", "op", "value"]);
      assertQueryableField(input.field);
      if (typeof input.value !== "string") {
        throw new TakibiProtocolError(`${op} requires a string`);
      }
      normalized = Object.freeze({
        field: input.field,
        op: op as QueryStringOperator,
        value: input.value,
      });
    } else if (typeof op === "string" && VALUE_OPERATORS.has(op as QueryValueOperator)) {
      assertExactKeys(input, ["field", "op", "value"]);
      assertQueryableField(input.field);
      assertQueryValue(op as QueryValueOperator, input.value);
      normalized = Object.freeze({
        field: input.field,
        op: op as QueryValueOperator,
        value: input.value,
      });
    } else if (op === "and" || op === "or") {
      assertExactKeys(input, ["op", "operands"]);
      if (!Array.isArray(input.operands) || input.operands.length < 2) {
        throw new TakibiProtocolError(`${op} requires at least two operands`);
      }
      normalized = Object.freeze({
        op,
        operands: Object.freeze(input.operands.map((operand) => visit(operand, depth + 1))),
      });
    } else if (op === "not") {
      assertExactKeys(input, ["op", "operand"]);
      normalized = Object.freeze({ op, operand: visit(input.operand, depth + 1) });
    } else {
      throw new TakibiProtocolError("Unknown query operator");
    }

    seen.delete(input);
    return normalized;
  };

  return visit(value, 1);
}

function parseJson(source: string, description: string): unknown {
  if (typeof source !== "string") {
    throw new TakibiProtocolError(`${description} must be a JSON string`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new TakibiProtocolError(`Invalid JSON ${description}`);
  }
}

function assertQueryValue(op: QueryValueOperator, value: unknown): asserts value is QueryScalar {
  const scalar =
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
  if (!scalar) {
    throw new TakibiProtocolError("Query value must be a JSON scalar with finite numbers");
  }
  if (op !== "eq" && typeof value !== "string" && typeof value !== "number") {
    throw new TakibiProtocolError(`${op} requires a string or finite number`);
  }
}

function normalizeInValues(value: unknown): readonly QueryScalar[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > QUERY_MAX_NODES) {
    throw new TakibiProtocolError(`in requires between 1 and ${QUERY_MAX_NODES} values`);
  }
  for (const entry of value) assertQueryValue("eq", entry);
  return Object.freeze([...value]) as readonly QueryScalar[];
}

function assertQueryableField(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TakibiProtocolError("Query field must be a non-empty string");
  }
  if (RESERVED_QUERY_FIELDS.has(value)) {
    throw new TakibiProtocolError(`${value} is reserved and cannot be queried`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new TakibiProtocolError("Query expression has unexpected fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
