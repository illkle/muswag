# muswag

Monorepo for a Navidrome/OpenSubsonic client stack.

## Workspace

- `packages/opensubsonic-types`: OpenAPI snapshot + generated TypeScript types.
- `packages/db`: Shared DB layer and album sync logic.

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Integration tests

```bash
pnpm test:integration
```

If Docker daemon is not available, integration tests are skipped with a message.

## OpenAPI workflow

Update spec snapshot (supports proxies):

```bash
OPENAPI_SOCKS5=127.0.0.1:2080 pnpm openapi:update
```

Regenerate TypeScript types:

```bash
pnpm generate:types
```
