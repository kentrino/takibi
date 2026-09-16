# Alternative: translate protocol capacity at the query boundary

## Example

Before: `compileWhere` throws a generic TypeError-compatible protocol error on a too-deep expression.

After: `import { compileWhere, QueryCapacityError } from 'takibi'` lets the same try/catch shown in design A select bounded fallback for `QUERY_MAX_DEPTH` with limit 8 and observed actual 9. Malformed queries still escape as ordinary validation failures.

## Ownership and comparison

Protocol defines a structured internal capacity error and remains independent of query. Query owns the public QueryCapacityError, catches only that internal capacity class around normalization, and maps its code/limit/observed actual without copying limits or inspecting messages. Builder in overflow uses the public error directly, with metadata semantics identical to design A. Raw HTTP parsing retains protocol identity; server policy composition keeps its sanitized scope error.

This isolates a public query error from protocol export changes but creates two classes and a mapping that every compilation entry must preserve. Re-exporting one low-level identity has lower maintenance cost and narrower change closure for three stable codes. Choose this alternative only if protocol's external error compatibility prevents adding the shared subclass; verify all protocol consumers and boundary tests to establish that constraint. No evidence currently establishes it.

Tests, callback determinism, migration compatibility, and capacity-vs-malformed classification are identical to design A. No implementation or tests were run for this candidate.
