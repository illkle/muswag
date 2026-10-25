# Songs benchmark

What it costs to get songs and albums to the renderer as the library grows, now that only main holds
them: every page reads them from main through its commands, and a write announces only the keys of the
rows it changed.

- `songs-page`: the reads the songs page makes, in each order: the first page with the count, a page
  by its offset, the page after or before one it holds, where typed letters jump to, and the ids of a
  selection of every song.
- `change-stream`: what announcing a change to every song (a first sync, a rescan) and to a thousand
  costs main.
- `detail-pages`: an album, an artist's albums with their songs, and a playlist's songs, each read
  from main.
- `albums`: the albums, which the renderer reads from main as it does the songs: the pages of the
  albums page, the artists with albums of their own, the cover ids of the albums of a list's rows, and
  the albums of a list of ids.

```
pnpm --filter @muswag/tests test:songs-benchmark
```

The libraries are copies of `apps/desktop/dev-library.db` (or `MUSWAG_BENCH_SOURCE`) with its songs and
albums repeated under new ids until there are enough, made once in the temp directory and migrated by
the app's layer when opened. What main's reads return is copied with V8's serializer the way Electron's
IPC does. `apps/desktop/scripts/ipc-benchmark.mjs` measures the real IPC in Electron.

| Variable             | Default                    |                                       |
| -------------------- | -------------------------- | ------------------------------------- |
| `MUSWAG_BENCH_SIZES` | `4358,25000,100000,250000` | Library sizes, in songs               |
| `MUSWAG_BENCH_OUT`   | temp directory             | Where the results are written as JSON |

Heap sizes are the JS heap after garbage collection, so they leave out SQLite's own memory.
