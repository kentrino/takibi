import type { QueryExpr, QueryScalar } from "takibi";

export type TestRow = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type QueryOptions = {
  index?: string;
  limit?: number;
  maxItems?: number;
  where?: (query: Record<string, unknown>) => QueryExpr;
};

export function createTestCollection(
  table: () => Map<string, TestRow>,
  onOperation?: (operation: string, options: unknown) => void,
) {
  const matching = (options?: QueryOptions) => {
    const expression = options?.where?.(createQueryBuilder());
    return [...table().values()].filter((row) => !expression || matchesQuery(row, expression));
  };
  const update = async (id: string, data: Record<string, unknown>) => {
    const existing = table().get(id);
    if (!existing) throw new Error("missing row");
    const row = structuredClone({
      ...existing,
      ...data,
      id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
    table().set(id, row);
    return structuredClone(row);
  };

  return {
    async add(
      data: Record<string, unknown>,
      options?: { id?: string; createdAt?: string; updatedAt?: string },
    ) {
      const id = options?.id ?? crypto.randomUUID();
      if (table().has(id)) throw new Error("duplicate id");
      const now = new Date().toISOString();
      const row = structuredClone({
        ...data,
        id,
        createdAt: options?.createdAt ?? now,
        updatedAt: options?.updatedAt ?? now,
      });
      table().set(id, row);
      return structuredClone(row);
    },
    update,
    async delete(id: string) {
      if (!table().delete(id)) throw new Error("missing row");
      return { id };
    },
    async list(options?: QueryOptions) {
      onOperation?.("list", options);
      const items = matching(options).slice(0, options?.limit);
      return { items: items.map((row) => structuredClone(row)) };
    },
    async listAll(options?: QueryOptions) {
      onOperation?.("listAll", options);
      return matching(options).map((row) => structuredClone(row));
    },
    async count(options?: QueryOptions) {
      onOperation?.("count", options);
      return matching(options).length;
    },
    async updateMany(data: Record<string, unknown>, options: QueryOptions) {
      onOperation?.("updateMany", options);
      const targets = matching(options);
      for (const target of targets) await update(target.id, data);
      return { updated: targets.length };
    },
    async deleteMany(options: QueryOptions) {
      onOperation?.("deleteMany", options);
      const targets = matching(options);
      for (const target of targets) table().delete(target.id);
      return { deleted: targets.length };
    },
    async consumeOne(options: QueryOptions) {
      onOperation?.("consumeOne", options);
      const target = matching(options)[0];
      if (!target) return null;
      table().delete(target.id);
      return structuredClone(target);
    },
    async incrementOne(
      increment: Record<string, number>,
      options: QueryOptions & { set?: Record<string, unknown> },
    ) {
      onOperation?.("incrementOne", options);
      const target = matching(options)[0];
      if (!target) return null;
      const values = Object.fromEntries(
        Object.entries(increment).map(([field, delta]) => [
          field,
          (typeof target[field] === "number" ? target[field] : 0) + delta,
        ]),
      );
      return update(target.id, { ...values, ...options.set });
    },
  };
}

function createQueryBuilder(): Record<string, unknown> {
  const field = (name: string) => ({
    present: (): QueryExpr => ({ field: name, op: "present" }),
    eq: (value: QueryScalar): QueryExpr => ({ field: name, op: "eq", value }),
    in: (values: readonly QueryScalar[]): QueryExpr => ({ field: name, op: "in", values }),
    gt: (value: string | number): QueryExpr => ({ field: name, op: "gt", value }),
    gte: (value: string | number): QueryExpr => ({ field: name, op: "gte", value }),
    lt: (value: string | number): QueryExpr => ({ field: name, op: "lt", value }),
    lte: (value: string | number): QueryExpr => ({ field: name, op: "lte", value }),
    contains: (value: string): QueryExpr => ({ field: name, op: "contains", value }),
    startsWith: (value: string): QueryExpr => ({ field: name, op: "startsWith", value }),
    endsWith: (value: string): QueryExpr => ({ field: name, op: "endsWith", value }),
  });
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") return undefined;
      if (property === "and" || property === "or") {
        return (first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr => ({
          op: property,
          operands: [first, second, ...rest],
        });
      }
      if (property === "not") {
        return (operand: QueryExpr): QueryExpr => ({ op: "not", operand });
      }
      return field(property);
    },
  });
}

function matchesQuery(document: Readonly<Record<string, unknown>>, expression: QueryExpr): boolean {
  if (!("field" in expression)) {
    if (expression.op === "not") return !matchesQuery(document, expression.operand);
    return expression.op === "and"
      ? expression.operands.every((operand) => matchesQuery(document, operand))
      : expression.operands.some((operand) => matchesQuery(document, operand));
  }
  const present = Object.prototype.hasOwnProperty.call(document, expression.field);
  if (expression.op === "present") return present;
  if (!present) return false;
  const actual = document[expression.field];
  if (expression.op === "in") return expression.values.includes(actual as QueryScalar);
  if (expression.op === "contains") {
    return typeof actual === "string" && actual.includes(expression.value);
  }
  if (expression.op === "startsWith") {
    return typeof actual === "string" && actual.startsWith(expression.value);
  }
  if (expression.op === "endsWith") {
    return typeof actual === "string" && actual.endsWith(expression.value);
  }
  if (expression.op === "eq") return actual === expression.value;
  if (typeof actual !== typeof expression.value) return false;
  if (typeof actual === "string" && typeof expression.value === "string") {
    if (expression.op === "gt") return actual > expression.value;
    if (expression.op === "gte") return actual >= expression.value;
    if (expression.op === "lt") return actual < expression.value;
    return actual <= expression.value;
  }
  if (typeof actual === "number" && typeof expression.value === "number") {
    if (expression.op === "gt") return actual > expression.value;
    if (expression.op === "gte") return actual >= expression.value;
    if (expression.op === "lt") return actual < expression.value;
    return actual <= expression.value;
  }
  return false;
}
