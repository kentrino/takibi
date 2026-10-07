---
title: Allow a replacement SQLite test resolver to define its input context type
author: OpenAI Codex
cost: 2
priority: P2
priority_reason: "Tests that replace production context resolution still require unused Worker bindings, encouraging unsafe casts."
category: devex
status: closed
closed_reason: implemented
---

# Allow a replacement SQLite test resolver to define its input context type

`withSqliteTestBackend(handler, { resolve: () => ({ room: "lobby" }) })`
replaces resolution and bypasses the production stub, but its returned `handle`
still requires the original input context, such as `{ env: ChatEnv; room: Room }`.
The realtime chat example consequently used fake Worker bindings. Removing
`createTakibi`'s second type argument does not fix this: the requirement comes
from the first input type.

Allow an explicitly supplied test resolver to define a different initial context
type while preserving the production resolved context, collections, actions, and
services contract. With no resolver override, retain the production input type.
Keep the returned handler's input metadata consistent with its `handle` signature.

Named-object routing and WebSocket emulation remain outside this change; the
SQLite backend continues to bypass `stub` and own one independent store per
handler.

## Related Files

- `packages/testing/src/testing.server.ts`
- `packages/worker-runtime/src/testing-bridge.server.ts`
- `examples/realtime-chat/tests/chat.test.ts`
- `packages/takibi/README.md`

## Resolution

An explicit replacement resolver now determines the SQLite test handler's input
context. A resolver with no input parameters defaults to an empty context, while
an annotated resolver input supplies a typed context. The returned `handle`
signature and Takibi brand metadata use the same replacement input type. Omitting
the resolver keeps the production input type. Production resolved context,
collections, actions, and required services remain unchanged.

Type checks cover empty and typed replacement inputs, matching metadata,
incompatible resolver output, missing services, and inherited production input.
Runtime coverage verifies that a replacement receives its test input and that a
separate inherited fork still uses the production resolver. The realtime chat
tests now pass only their room context and no longer construct unused Worker
bindings. Public testing documentation describes both resolver modes.

The initial focused type check failed on the replacement resolver and returned
handler input as expected before implementation. Validation: `pnpm run ready`
(format, lint, types, all Node and Workers tests, and package/example builds).
