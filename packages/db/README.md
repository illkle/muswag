# @muswag/db

Shared consumer-facing database package for OpenSubsonic/Navidrome sync.

## Consumer API

```ts
import { Database, createBetterSqliteAdapter } from "@muswag/db";

const adapter = createBetterSqliteAdapter("./app.db");
const db = new Database(adapter);

await db.sync({
  connection: {
    baseUrl: "http://127.0.0.1:4533",
    username: "admin",
    password: "adminpass",
    clientName: "muswag"
  }
});

const albums = await db.getAlbumList();
const album = await db.getAlbumById(albums[0]!.id);
```

## Typed models

`AlbumSchema` and `GetAlbumListOptionsSchema` are exported (Zod), and TypeScript types are inferred from them.

## Commands

- `pnpm -C packages/db test`
- `pnpm -C packages/db test:integration`
