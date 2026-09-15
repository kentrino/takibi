# Alternative: snapshot response with bounded migration persistence

## Design

If measured occupancy warrants it, acquire a stable read view, transform/filter against that view, and persist migrated rows in bounded transactions guarded by source revision. The response must remain derived from the original view even if persistence sees a newer row or deletion. Source comparison already exists in migrations, but response and persistence currently share results; separating them changes behavior.

A true read snapshot capability would be needed to avoid materializing all candidates. Its availability/cost on the supported DO SQLite adapter is unverified; establish it with a small adapter-level probe before selecting this candidate. If unavailable, quantify materialization memory or reject this candidate. An enclosing atomic action/$transaction always keeps the existing boundary.

Partial committed migrations survive a later error unless extra staging is introduced. Decide and document uniqueness validation timing, which writes survive, how migration errors propagate, and whether this intentionally replaces operation-level rollback. Omitting list persistence entirely is a simpler variant with repeated computation and deferred uniqueness enforcement, but does not itself solve snapshot acquisition. A new package is not justified: storage owns snapshots; runtime owns migration/policy.

## Example

Before: one policy-bound `api.items.list({ limit: 20 })` rolls back all migration writes if the last candidate fails uniqueness validation.

After (only if explicitly adopted): the same call reads a stable view and fails, but earlier bounded migration writes may already be committed. Unrelated writes may proceed between persistence batches. This is a README contract change, not a transparent implementation detail. Inside `$transaction`, the before behavior remains.

## Comparison and verification

Compared with `full`, this hides persistence scheduling from callers but increases storage APIs and failure-state complexity. Benchmark the same fixtures as design A, with cursor/index/filter lookahead parity and update/delete races. Reject if memory is unbounded, snapshot guarantees cannot be implemented, or measured waiting-time gains do not justify rollback changes.
