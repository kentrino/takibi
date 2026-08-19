import type { QueryExpr, QueryOperator, QueryScalar } from "./types";

export type SqlBinding = string | number | null;

export type SqlPredicate = {
  sql: string;
  bindings: SqlBinding[];
};

const SQL_OPERATORS: Record<QueryOperator, string> = {
  eq: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

const METADATA_COLUMNS: Readonly<Record<string, string>> = {
  id: "id",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

export function compileQueryToSql(expression: QueryExpr): SqlPredicate {
  if ("field" in expression) return compileLeaf(expression.field, expression.op, expression.value);

  if (expression.op === "not") {
    const operand = compileQueryToSql(expression.operand);
    return { sql: `(NOT ${operand.sql})`, bindings: operand.bindings };
  }

  const compiled = expression.operands.map(compileQueryToSql);
  return {
    sql: `(${compiled.map(({ sql }) => sql).join(` ${expression.op.toUpperCase()} `)})`,
    bindings: compiled.flatMap(({ bindings }) => bindings),
  };
}

function compileLeaf(field: string, operator: QueryOperator, value: QueryScalar): SqlPredicate {
  const metadataColumn = METADATA_COLUMNS[field];
  if (metadataColumn !== undefined) {
    return compileMetadataLeaf(metadataColumn, operator, value);
  }

  const prefix = "EXISTS (SELECT 1 FROM json_each(data) AS takibi_field WHERE takibi_field.key = ?";
  if (value === null) {
    return operator === "eq"
      ? { sql: `(${prefix} AND takibi_field.type = 'null'))`, bindings: [field] }
      : { sql: "0", bindings: [] };
  }
  if (typeof value === "boolean") {
    return operator === "eq"
      ? {
          sql: `(${prefix} AND takibi_field.type = '${value ? "true" : "false"}'))`,
          bindings: [field],
        }
      : { sql: "0", bindings: [] };
  }
  if (typeof value === "string") {
    if (operator !== "eq" && requiresJavaScriptTextOrdering(value)) {
      return {
        sql: `(${prefix} AND takibi_field.type = 'text'))`,
        bindings: [field],
      };
    }
    return {
      sql: `(${prefix} AND takibi_field.type = 'text' AND takibi_field.atom ${SQL_OPERATORS[operator]} ?))`,
      bindings: [field, value],
    };
  }
  return {
    sql: `(${prefix} AND takibi_field.type IN ('integer', 'real') AND takibi_field.atom ${SQL_OPERATORS[operator]} ?))`,
    bindings: [field, value],
  };
}

function compileMetadataLeaf(
  column: string,
  operator: QueryOperator,
  value: QueryScalar,
): SqlPredicate {
  if (typeof value !== "string") return { sql: "0", bindings: [] };
  if (operator !== "eq" && requiresJavaScriptTextOrdering(value)) {
    return { sql: `(${column} IS NOT NULL)`, bindings: [] };
  }
  return { sql: `(${column} ${SQL_OPERATORS[operator]} ?)`, bindings: [value] };
}

function requiresJavaScriptTextOrdering(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) >= 0xd800) return true;
  }
  return false;
}
