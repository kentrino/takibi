---
id: "0014"
title: Domain dates are schema fields, not document timestamps
status: accepted
implementation: not-applicable
created: 2026-10-07
---

# Domain dates are schema fields, not document timestamps

Seeds take the activation write time as `createdAt` / `updatedAt`; a request to let each seed entry supply its own values is declined. `createdAt` / `updatedAt` remain server-managed on every write path, including collection `seed`. Seed entries stay schema inputs keyed by document ID; no per-entry timestamp override is added. An application that needs a displayable or orderable date — a publish date, demo fixtures with fixed dates — declares it as a schema field such as `publishedAt` with an index for ordering, and can default it to the write time with a schema default such as `z.iso.datetime().default(() => new Date().toISOString())`, which validation fills in whenever the field is absent from the input on any write path.

Document timestamps are observational only. Letting seeds set them would split their meaning between "time the document was saved" and "backfilled domain date" and make indexes and `orderBy` over `createdAt` ambiguous. A schema field needs no Takibi change and also covers later edits and scheduled publication (`publishedAt.lte(now)`), which `createdAt` cannot: it is fixed at creation and would have to claim a future save time. Trusted `$collections.add` already accepts `createdAt` / `updatedAt` and remains the only per-document override path, intended for one-off trusted writes such as imports; snapshot restore preserves timestamps only for Takibi's own export format. Lazy migrations receive only domain data, so backfilling a new date field from `createdAt` on existing documents takes a one-off trusted pass (`list`, then `update` with `publishedAt: doc.createdAt`), not a collection migration.

Revisit if a real import from an external system must preserve original `createdAt` values at a volume where per-document trusted `add` calls are impractical; even then prefer a dedicated import path over seed, which is create-only and re-evaluated on every Durable Object activation.
