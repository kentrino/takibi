---
id: "0008"
title: Throw inside the server and return results across the client boundary
status: accepted
implementation: complete
created: 2026-09-16
---

# Throw inside the server and return results across the client boundary

Server-side collection operations return success values directly and throw on failure on both policy-bound and trusted surfaces. At execution boundaries, library and validation errors become public error envelopes; unexpected exceptions become `INTERNAL` failures. Public client CRUD and actions return server-decided outcomes as `TakibiResult<T>`.

Serialization, network, abort, JSON decoding, and malformed-envelope failures reject the client Promise: transport/protocol failures differ from returned operation failures. Exceptions compose server work naturally while the typed public union keeps expected remote failures explicit. Revisit if server applications repeatedly need error accumulation; add an explicit server Result helper without changing the client envelope contract.
