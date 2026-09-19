# Takibi

Typed multi-tenant collection store on Cloudflare Durable Objects — with
end-to-end types from `typeof handler` to `createClient`.

```ts
import { createTakibi, fullAccess } from "takibi";
import { createClient } from "takibi/client";
```

The public SDK is the unscoped `takibi` package. Optional adapters live
under `@takibi/*`.

```sh
pnpm add takibi
```

## Packages

| Package                                                         | Description                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| [`takibi`](./packages/takibi)                                   | Public SDK: `createTakibi`, client, testing, instrumentation |
| [`@takibi/hono-adapter`](./packages/hono-adapter)               | Hono middleware for Takibi HTTP handlers                     |
| [`@takibi/better-auth-adapter`](./packages/better-auth-adapter) | Better Auth adapter                                          |
| [`@takibi/opentelemetry`](./packages/opentelemetry)             | Optional OpenTelemetry integration                           |
| [`@takibi/cloudflare-tracing`](./packages/cloudflare-tracing)   | Optional Cloudflare Workers native tracing adapter           |

Internal workspace packages are private and are not published. Import
`takibi` or an adapter, not `@takibi/policy` and friends.

See the [SDK guide](./packages/takibi/README.md) for AuthN/AuthZ, collections,
actions, HTTP, and [opt-in list watches](./packages/takibi/README.md#watch-list-snapshots) via `takibi/watch`.

See [RFCs](./docs/rfcs/README.md) for design proposals, decisions, and their
implementation status.

## Examples

- [Realtime chat](./examples/realtime-chat): a public, no-login chat using
  `takibi/watch`, Hono, and Tailwind, with one Durable Object per room.

## Development

```sh
pnpm install
pnpm ready
```

`pnpm ready` type-checks, tests, and builds every workspace package.

Publishing uses Release Please and npm trusted publishing. See
`docs/playbook/` for GitHub App access, trusted publishers, and first
publish of a new public package.

## License

[MIT](./LICENSE)
