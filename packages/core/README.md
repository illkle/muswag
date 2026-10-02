# @muswag/core

Main-process services. Main owns the library database; renderers mirror its tables through `@muswag/tanstack-db-sqlite-mirror` and change things only through commands.

- **Database:** SQLite through Effect's `@effect/sql-sqlite-node` (Node's built-in `node:sqlite`) and Drizzle's Effect driver. The schema lives in `@muswag/shared` (`src/db/schema.ts`), so the renderer gets the same row types. `MIRRORED_TABLES` lists what renderers see; credentials, covers, the player queue and sync state stay in main.
- **Writes:** anything that changes a mirrored table runs inside `MirrorServer.write`, which commits it in one transaction and pushes the changes to renderers after the commit.
- **Services:** `SessionManager` (login, restore, logout, and the services of the logged-in session), `LibrarySync`, `PlaylistSyncManager` with `PlaylistCommands`, `CoverManager` and `CredentialsStoreSql`. `CoreLive` composes them; main provides the platform (`HttpClient`, `Crypto`, `Path`, `MiniFs`).

## Schema changes

Edit `packages/shared/src/db/schema.ts`, then run `pnpm db:generate` here. It writes a drizzle-kit migration to `drizzle/` and embeds it into `src/db/migrations.generated.ts`, which the app runs at startup. A test fails if the two disagree.

## Testing

`@muswag/core/testing` provides an in-memory database (`TestDatabase`), an API stub (`makeApi`) and Subsonic fixtures.
