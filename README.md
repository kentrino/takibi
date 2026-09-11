# Takibi

Typed multi-tenant collection store on Cloudflare Durable Objects — with
end-to-end types from `typeof handler` to `createClient`.

```ts
import { createTakibi, fullAccess } from "takibi";
import { createClient } from "takibi/client";
```

The public SDK is the unscoped `takibi` package. Adapters and internals live
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

Internal packages (`@takibi/policy`, `@takibi/storage`, `@takibi/client`, …)
are published for the SDK graph. Application code should import `takibi`.

See the [SDK guide](./packages/takibi/README.md) for AuthN/AuthZ, collections,
actions, and HTTP.

## Development

```sh
pnpm install
pnpm ready
```

`pnpm ready` type-checks, tests, and builds every workspace package.

## License

[MIT](./LICENSE)
