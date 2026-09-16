---
id: "0007"
title: Separate action admission from document authorization
status: accepted
implementation: complete
created: 2026-09-16
---

# Separate action admission from document authorization

An action gate is required before its handler; staged definitions require `.policy()` before `.handler()`, and registration rejects invalid definitions. Normal `collection`/`collections` operations in the handler evaluate each target collection's `accessPolicy`. Trusted `$collection`/`$collections` operations bypass only collection policy: they never bypass the action gate, schema validation, or metadata management.

The `$` convention makes privileged access visible. The Durable Object's `this.$collections` is a trusted administrative surface unavailable to public HTTP CRUD, while the `$` root-action wire scope does not imply bypass. Keep trusted operations separate rather than adding an action-wide bypass or `admin`/`asUser` split. Revisit only for repeated shared gate needs, non-request server workflows, or audit-proven opt-in requirements while preserving the two distinctions.
