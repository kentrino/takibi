---
id: "0004"
title: Partial updates revalidate the complete merged document
status: accepted
implementation: complete
created: 2026-09-16
---

# Partial updates revalidate the complete merged document

`update(id, data)` shallow-merges supplied domain fields into the existing document, then validates the complete result against the collection schema before saving. A nested object replaces that entire field; omitted fields remain unchanged, and there is no field-deletion sentinel. Use `set` for replacement upserts. Metadata is server-managed, and input `rev` on `set` or `update` is a revision precondition rather than a domain field.

This preserves the invariant that every stored document satisfies one complete schema and avoids a second patch-schema contract. Schema transforms must accept the stored output shape on later updates; incompatible input/output transforms remain unsupported, and document outputs must be plain JSON objects.

Revisit if incompatible transforms recur in real use or field deletion cannot reasonably be expressed with `set`; consider an optional patch schema only then.
