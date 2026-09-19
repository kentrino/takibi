---
title: Allow a replacement SQLite test resolver to define its input context type
author: OpenAI Codex
cost: 2
priority: P2
priority_reason: "Tests that replace production context resolution still require unused Worker bindings, encouraging unsafe casts."
category: devex
---

# Allow a replacement SQLite test resolver to define its input context type

`withSqliteTestBackend(handler, { resolve: () => ({ room: "lobby" }) })`
replaces resolution and bypasses the production stub, but its returned `handle`
still requires the original input context, such as `{ env: ChatEnv; room: Room }`.
The realtime chat example consequently used `env: {} as never`. Removing
`createTakibi`'s second type argument does not fix this: the requirement comes
from the first input type.

Allow an explicitly supplied test resolver to define a different initial context
type while preserving the production resolved context, collections, actions, and
services contract. With no resolver override, retain the production input type.
Keep the returned handler's input metadata consistent with its `handle` signature.

Completion requires type checks for replacement resolvers with empty and typed
inputs, rejection of incompatible resolved outputs and missing required services,
and preservation of production input requirements when no override is supplied.
Runtime tests must verify that the replacement resolver receives the test input
and that the original handler is unaffected. Update the public testing docs and
simplify the realtime chat test setup where applicable.

Named-object routing and WebSocket emulation are outside this change; the SQLite
backend continues to bypass `stub` and own one independent store per handler.

## Related Files

- `packages/testing/src/testing.server.ts`
- `packages/worker-runtime/src/testing-bridge.server.ts`
- `packages/worker-runtime/src/context/application.ts`
- `examples/realtime-chat/tests/chat.test.ts`
- `packages/takibi/README.md`
