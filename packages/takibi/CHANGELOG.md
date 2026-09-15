# Changelog

## [0.4.0](https://github.com/kentrino/takibi/compare/takibi-v0.3.1...takibi-v0.4.0) (2026-09-15)


### Features

* **policy:** enforce policy-owned list and count ranges ([98c759d](https://github.com/kentrino/takibi/commit/98c759d1b7a9d391c966658c5768a3c1b257e4df))

## [0.3.1](https://github.com/kentrino/takibi/compare/takibi-v0.3.0...takibi-v0.3.1) (2026-09-15)


### Miscellaneous

* create kentrino/2026/09/15-24 ([382aa1b](https://github.com/kentrino/takibi/commit/382aa1b53babcc97e3cd6fd78531899da96d9cb2))

## [0.3.0](https://github.com/kentrino/takibi/compare/takibi-v0.2.0...takibi-v0.3.0) (2026-09-14)


### Features

* **cloudflare-tracing:** map Takibi spans onto Workers native enterSpan ([74bb56e](https://github.com/kentrino/takibi/commit/74bb56e6a211cb35fdf0f721e863ccc7048506c2))
* **cloudflare-tracing:** map Takibi spans onto Workers native enterSpan ([5ebed45](https://github.com/kentrino/takibi/commit/5ebed45ce0d562b587070c327e42c6bfb8a43b81))

## [0.2.0](https://github.com/kentrino/takibi/compare/takibi-v0.1.0...takibi-v0.2.0) (2026-09-14)


### Features

* **examples:** extract the public-api issue-tracker scenario ([154885d](https://github.com/kentrino/takibi/commit/154885df90ebdd426c32c51fc3c69088acb355f2))
* **takibi:** inline private workspace packages in the published sdk ([3df861f](https://github.com/kentrino/takibi/commit/3df861f1f98f17da79e8fefa286072cdeef3e623))


### Bug Fixes

* **takibi:** invoke handler.handle in the http test helper ([2fd45a0](https://github.com/kentrino/takibi/commit/2fd45a072569f2c7b2c6825492ed9882365040d4))


### Refactoring

* drop takibi- prefix from published package names ([3eb5cb7](https://github.com/kentrino/takibi/commit/3eb5cb7710525ff56cac122c178b8dafa35484fc))
* import public package exports in tests and benches ([b67efe9](https://github.com/kentrino/takibi/commit/b67efe924040e04aaedf63cfa1fefd5955ae325e))
* **worker-runtime:** extract invocation lifecycle into @takibi/invocation-lifecycle ([1b1de81](https://github.com/kentrino/takibi/commit/1b1de8112d820c55cec0f19a198faf1bb1b33152))


### Documentation

* add npm install snippets to public packages ([bc3c330](https://github.com/kentrino/takibi/commit/bc3c3301f8ed955732fa08d9c4997078a5f1fd20))


### Tests

* **takibi:** assert public packages point at kentrino/takibi ([0c447ae](https://github.com/kentrino/takibi/commit/0c447aed7f7e05a7832d128e277008247190b6e9))


### Miscellaneous

* bootstrap vite+ pnpm workspace ([2e65ebb](https://github.com/kentrino/takibi/commit/2e65ebb7b02d4dbc5c0f49df7338a5ed0861cb78))
* create kentrino/2026/09/12-3 ([56bc7de](https://github.com/kentrino/takibi/commit/56bc7dea1bfd57a2d3dd0efa5dd90781e789b646))
* create kentrino/2026/09/14-19 ([65a10c2](https://github.com/kentrino/takibi/commit/65a10c2b463060e331ff7aee9724b69b117c89eb))
* create kentrino/2026/09/14-7 ([f27618c](https://github.com/kentrino/takibi/commit/f27618ca5a477a0427fc0ba1b9e907b5625c3222))
* keep only the sdk and adapters publishable ([051e678](https://github.com/kentrino/takibi/commit/051e678ae675f7791a9579b2c4ae4a515dabd323))
* **main:** release takibi 0.1.0 ([a39eafb](https://github.com/kentrino/takibi/commit/a39eafbfa08359d0a5f21e63f233a86a5a12bf6d))
* **main:** release takibi 0.1.0 ([7081bd4](https://github.com/kentrino/takibi/commit/7081bd408c8543794ce2b24437b959d736711e15))
* set LICENSE copyright to Kento Haneda ([f12dea7](https://github.com/kentrino/takibi/commit/f12dea74c891f5b8203e07b4eb3ce0e7a5c25c38))
* **takibi:** set version to 0.0.1 to match npm ([3d5d38e](https://github.com/kentrino/takibi/commit/3d5d38ed42df18cf0f679c9480d3c7e50eb574a1))

## [0.1.0](https://github.com/kentrino/takibi/compare/takibi-v0.0.1...takibi-v0.1.0) (2026-09-14)


### Features

* **examples:** extract the public-api issue-tracker scenario ([154885d](https://github.com/kentrino/takibi/commit/154885df90ebdd426c32c51fc3c69088acb355f2))
* **takibi:** inline private workspace packages in the published sdk ([3df861f](https://github.com/kentrino/takibi/commit/3df861f1f98f17da79e8fefa286072cdeef3e623))


### Bug Fixes

* **takibi:** invoke handler.handle in the http test helper ([2fd45a0](https://github.com/kentrino/takibi/commit/2fd45a072569f2c7b2c6825492ed9882365040d4))


### Refactoring

* drop takibi- prefix from published package names ([3eb5cb7](https://github.com/kentrino/takibi/commit/3eb5cb7710525ff56cac122c178b8dafa35484fc))
* import public package exports in tests and benches ([b67efe9](https://github.com/kentrino/takibi/commit/b67efe924040e04aaedf63cfa1fefd5955ae325e))
* **worker-runtime:** extract invocation lifecycle into @takibi/invocation-lifecycle ([1b1de81](https://github.com/kentrino/takibi/commit/1b1de8112d820c55cec0f19a198faf1bb1b33152))


### Documentation

* add npm install snippets to public packages ([bc3c330](https://github.com/kentrino/takibi/commit/bc3c3301f8ed955732fa08d9c4997078a5f1fd20))


### Tests

* **takibi:** assert public packages point at kentrino/takibi ([0c447ae](https://github.com/kentrino/takibi/commit/0c447aed7f7e05a7832d128e277008247190b6e9))


### Miscellaneous

* bootstrap vite+ pnpm workspace ([2e65ebb](https://github.com/kentrino/takibi/commit/2e65ebb7b02d4dbc5c0f49df7338a5ed0861cb78))
* create kentrino/2026/09/12-3 ([56bc7de](https://github.com/kentrino/takibi/commit/56bc7dea1bfd57a2d3dd0efa5dd90781e789b646))
* create kentrino/2026/09/14-7 ([f27618c](https://github.com/kentrino/takibi/commit/f27618ca5a477a0427fc0ba1b9e907b5625c3222))
* keep only the sdk and adapters publishable ([051e678](https://github.com/kentrino/takibi/commit/051e678ae675f7791a9579b2c4ae4a515dabd323))
* set LICENSE copyright to Kento Haneda ([f12dea7](https://github.com/kentrino/takibi/commit/f12dea74c891f5b8203e07b4eb3ce0e7a5c25c38))
* **takibi:** set version to 0.0.1 to match npm ([3d5d38e](https://github.com/kentrino/takibi/commit/3d5d38ed42df18cf0f679c9480d3c7e50eb574a1))
