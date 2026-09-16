---
id: "0006"
title: Cloudflare Durable Objects only
status: accepted
implementation: complete
created: 2026-09-16
---

# Cloudflare Durable Objects only

Durable Objects are Takibi's supported production backend, and the generated Durable Object class with one object per tenant is the first-class experience. The storage abstraction is an internal implementation and testing seam, not a public driver API.

Tenant isolation and Durable Object semantics are cohesive platform capabilities. A public driver contract would promise ordering, cursors, transactions, and performance across backends prematurely; promoting the seam later is compatible, retracting a public extension point is not. Revisit when evidence-backed demand for another backend exists and its semantics satisfy a stable contract.
