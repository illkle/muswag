# @muswag/opensubsonic-types

Generated and curated TypeScript types for OpenSubsonic.

## Commands

- `pnpm -C packages/opensubsonic-types openapi:update`
- `pnpm -C packages/opensubsonic-types generate`
- `pnpm -C packages/opensubsonic-types typecheck`

## Proxy support

If OpenAPI fetch must go through SOCKS5:

```bash
OPENAPI_SOCKS5=127.0.0.1:2080 pnpm -C packages/opensubsonic-types openapi:update
```

Or for generic proxy:

```bash
OPENAPI_PROXY=http://127.0.0.1:8080 pnpm -C packages/opensubsonic-types openapi:update
```

## Snapshot policy

`openapi/openapi.json` is committed for deterministic/offline generation.
Regenerate `src/generated.ts` whenever the snapshot is updated.
