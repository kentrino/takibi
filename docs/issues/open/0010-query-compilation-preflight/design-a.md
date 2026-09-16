# One capacity authority with a public error identity

## Decision and evidence

Retain the issue. `compileWhere` already exists in query and the internal facade file, but the package root does not export it and package.json has no `takibi/query` export. Better Auth duplicates 32/8 limits, estimates expansion, and separately caps `in`. Exporting constants would leave expansion duplicated. `98c759d` added server-owned scope composition: public normalization uses 32 nodes/8 depth, server composition 64/16. Preflight must not promise that an arbitrary callback validates policy composition or collection-specific index rules.

## Example

Before: adapter estimates shape and returns undefined for its bounded scan path, then later collection execution compiles the callback.

After (proposed public API):

```ts
import { compileWhere, QueryCapacityError } from "takibi";
const where = (q: import("takibi").QueryBuilder<{ email: string }>) => q.email.in(addresses); // addresses: string[]
try {
  const expression = compileWhere(where); // normalized QueryExpr, no storage I/O
  // The adapter retains `where` for the collection call; expression is not an API overload.
} catch (error) {
  if (!(error instanceof QueryCapacityError)) throw error;
  // Choose the existing configured bounded scan before executing any collection call.
}
```

For 33 valid addresses the error is `QUERY_IN_MAX_VALUES`, limit 32, actual 33. Empty/non-scalar `in`, foreign-builder operands, and unknown operators are validation TypeErrors, not reasons to hide malformed queries through fallback. The adapter freezes/copies cleaned DSL inputs before making its deterministic callback; preflight plus execution invokes the callback twice. General callers must not assume side effects run once.

## Recommended ownership and contract

Define `QueryCapacityCode = "QUERY_MAX_NODES" | "QUERY_MAX_DEPTH" | "QUERY_IN_MAX_VALUES"` and a `QueryCapacityError` extending `TakibiProtocolError` (which extends TypeError) in protocol, then re-export the same constructor through query and the takibi root. Protocol already owns normalization and can throw it without depending on query. Query uses that same error for builder `in` overflow. Keep code/limit/actual readonly and value-free; messages contain no document/query data.

`actual` is the observed count at the point validation aborts, not a promise of the total AST size: node overflow reports 33, depth reports the first forbidden depth, and array cardinality reports its length. Do not traverse untrusted/cyclic input after a known failure just to calculate a total. Keep ordinary protocol error handling and HTTP sanitization compatible. Server budgets remain internal; composed-scope failures must keep ListScopeError's safe reporting.

Check that `in` receives an array and is nonempty before its cardinality check. An oversized array aborts with capacity before scanning its elements; non-scalar values in an in-capacity array remain ordinary TypeErrors. Mixed malformed-and-oversized inputs follow bounded validation order, with no promise to find every later invalid element or branch. This precedence preserves safe public untrusted-ingest bounds without classifying valid-size malformed inputs as capacity.

[Alternative B](./design-b.md) maps low-level capacity errors at the query boundary. A direct re-export is recommended because it avoids translation and gives builder/normalizer one identity. No new package is justified: protocol is the stable capability and adapters own fallback policy.

## Migration and verification

Additive root exports; no raw QueryExpr overload or new HTTP error payload. Remove estimator/copied limits, including the in-length capacity gate, retaining Better-Auth-specific unsupported modes/operators. Capacity alone selects existing bounded fallback; other runtime errors propagate. Check conditional writes, list, and count both below and over capacity, and `in` values at 0/32/33 with malformed inputs. Check public preflight expression equality with collection compilation, server composition separation, duplicate constructor identity across facade exports, sanitized wire behavior, Node SQLite and Workers result parity.

Implementation completion requires `vp check`, query tests, Better Auth Node/Workers tests, public-export tests, and repository-wide gate. This rethink inspected code and history; none of those implementation checks were run. Whether duplicate installed facade versions need cross-copy error branding is unverified; inspect the adapter packaging/root import tests first. If constructor identity cannot be maintained, adopt an explicit trusted structural guard without accepting arbitrary user-thrown objects as capacity.
