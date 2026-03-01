# @muswag/db

Shared DB package for syncing OpenSubsonic/Navidrome data.

## What it provides

- `DbAdapter` abstraction for cross-platform database backends.
- `createBetterSqliteAdapter(filename)` for current JS SQLite usage.
- `migrate(db)` to create required tables.
- `syncAlbums(options)` to perform full album reconcile sync.

## Sync behavior

- Uses Subsonic query auth (`u`, `t`, `s`, `v`, `c`, `f=json`).
- Fetches albums via `getAlbumList2` (paged, `alphabeticalByName`).
- Upserts current albums and deletes stale rows not present remotely.

## Testing

- Unit tests: `pnpm -C packages/db test`
- Integration tests (Docker/Testcontainers): `pnpm -C packages/db test:integration`
