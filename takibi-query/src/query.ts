import { normalizeOrderBy, normalizeQueryExpr, QUERY_MAX_NODES } from "@takibi/takibi-protocol";
import type {
  OrderBuilder,
  OrderExpr,
  QueryBuilder,
  QueryExpr,
  QueryScalar,
  QueryStringOperator,
  QueryValueOperator,
  StorageListOptions,
} from "@takibi/takibi-shared-types";
import type { ListOptions } from "./list-options";

export function compileListOptions<
  TDoc,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
>(options: ListOptions<TDoc, TIndexes> | undefined): StorageListOptions | undefined {
  if (!options) return undefined;
  const index = "index" in options ? options.index : undefined;
  const orderBy = "orderBy" in options ? options.orderBy : undefined;
  if (orderBy !== undefined && (index === undefined || index === "")) {
    throw new TypeError("orderBy requires index");
  }
  const compiled: StorageListOptions = {
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.where !== undefined ? { where: compileWhere(options.where) } : {}),
    ...(typeof index === "string" ? { index } : {}),
    ...(orderBy !== undefined ? { orderBy: compileOrderBy(orderBy) } : {}),
  };
  return Object.keys(compiled).length === 0 ? undefined : compiled;
}

export function compileOrderBy(
  callback: (query: OrderBuilder<readonly string[]>) => OrderExpr,
): OrderExpr {
  if (typeof callback !== "function") {
    throw new TypeError("orderBy must be an order builder callback");
  }

  const expressions = new WeakSet<object>();
  const query = createOrderBuilder(expressions);
  const result = callback(query);
  if (!isRecord(result) || !expressions.has(result)) {
    throw new TypeError("orderBy callback must return an expression created by its query builder");
  }
  return normalizeOrderBy(result);
}

function createOrderBuilder(expressions: WeakSet<object>): OrderBuilder<readonly string[]> {
  const fields = new Map<string, object>();
  const register = (expression: OrderExpr): OrderExpr => {
    const frozen = Object.freeze(expression);
    expressions.add(frozen);
    return frozen;
  };

  return new Proxy(Object.create(null) as OrderBuilder<readonly string[]>, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") return undefined;
      let methods = fields.get(property);
      if (methods) return methods;
      methods = Object.freeze({
        asc: () => register({ field: property, direction: "asc" }),
        desc: () => register({ field: property, direction: "desc" }),
      });
      fields.set(property, methods);
      return methods;
    },
  });
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

    const leaf = (op: QueryValueOperator, value: unknown): QueryExpr => {
      assertQueryValue(op, value);
      return register({ field, op, value });
    };
    const stringLeaf = (op: QueryStringOperator, value: unknown): QueryExpr => {
      if (typeof value !== "string") throw new TypeError(`${op} requires a string`);
      return register({ field, op, value });
    };
    methods = Object.freeze({
      present: () => register({ field, op: "present" }),
      eq: (value: unknown) => leaf("eq", value),
      in: (values: unknown) => {
        const normalized = normalizeInValues(values);
        return register({ field, op: "in", values: normalized });
      },
      gt: (value: unknown) => leaf("gt", value),
      gte: (value: unknown) => leaf("gte", value),
      lt: (value: unknown) => leaf("lt", value),
      lte: (value: unknown) => leaf("lte", value),
      contains: (value: unknown) => stringLeaf("contains", value),
      startsWith: (value: unknown) => stringLeaf("startsWith", value),
      endsWith: (value: unknown) => stringLeaf("endsWith", value),
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

export function matchesQuery(
  document: Readonly<Record<string, unknown>>,
  expression: QueryExpr,
): boolean {
  if ("field" in expression) {
    const present = Object.prototype.hasOwnProperty.call(document, expression.field);
    if (expression.op === "present") return present;
    if (!present) return false;
    const actual = document[expression.field];
    if (expression.op === "in") {
      return expression.values.some((value) => matchesScalarEquality(actual, value));
    }
    if (
      expression.op === "contains" ||
      expression.op === "startsWith" ||
      expression.op === "endsWith"
    ) {
      if (typeof actual !== "string" || typeof expression.value !== "string") return false;
      if (expression.op === "contains") return actual.includes(expression.value);
      if (expression.op === "startsWith") return actual.startsWith(expression.value);
      return actual.endsWith(expression.value);
    }
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
          (typeof actual === "string" &&
            typeof expression.value === "string" &&
            actual > expression.value) ||
          (typeof actual === "number" &&
            typeof expression.value === "number" &&
            actual > expression.value)
        );
      case "gte":
        return (
          (typeof actual === "string" &&
            typeof expression.value === "string" &&
            actual >= expression.value) ||
          (typeof actual === "number" &&
            typeof expression.value === "number" &&
            actual >= expression.value)
        );
      case "lt":
        return (
          (typeof actual === "string" &&
            typeof expression.value === "string" &&
            actual < expression.value) ||
          (typeof actual === "number" &&
            typeof expression.value === "number" &&
            actual < expression.value)
        );
      case "lte":
        return (
          (typeof actual === "string" &&
            typeof expression.value === "string" &&
            actual <= expression.value) ||
          (typeof actual === "number" &&
            typeof expression.value === "number" &&
            actual <= expression.value)
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

function assertQueryValue(op: QueryValueOperator, value: unknown): asserts value is QueryScalar {
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

function normalizeInValues(value: unknown): readonly QueryScalar[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > QUERY_MAX_NODES) {
    throw new TypeError(`in requires between 1 and ${QUERY_MAX_NODES} values`);
  }
  for (const entry of value) assertQueryValue("eq", entry);
  return Object.freeze([...value]) as readonly QueryScalar[];
}

function matchesScalarEquality(actual: unknown, expected: QueryScalar): boolean {
  if (actual === null || expected === null) return actual === expected;
  if (typeof actual !== typeof expected) return false;
  return (
    (typeof actual === "string" || typeof actual === "number" || typeof actual === "boolean") &&
    actual === expected
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
