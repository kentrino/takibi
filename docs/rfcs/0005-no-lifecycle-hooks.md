---
id: "0005"
title: Do not expose collection write lifecycle hooks
status: accepted
implementation: complete
created: 2026-09-16
---

# Do not expose collection write lifecycle hooks

Takibi does not expose collection write hooks or middleware chains such as `beforeWrite` or `onWrite`. Use schemas for defaults and transformations, `accessPolicy` with `doc`/`nextDoc` for value-based authorization, and actions for context-dependent server work such as author assignment. Document metadata remains server-managed.

Making hooks public would commit ordering, validation, authorization, and reentrant-write behavior to the API. The chosen mechanisms cover these cases without that contract. Revisit when multiple real collections need shared behavior those mechanisms cannot express, especially server-enforced replacement during ordinary client CRUD; define one precisely ordered hook before a hook matrix.
