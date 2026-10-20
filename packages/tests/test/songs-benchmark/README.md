# Songs benchmark

What it costs to get songs and albums to the renderer as the library grows, now that only main holds
them: the songs and albums pages read pages from main, other pages read them through on-demand
collections, and the change stream carries only the keys of changed songs and albums.

- `songs-page`: the reads the songs page makes, in each order: the first page with the count, a page
  by its offset, the page after or before one it holds, where typed letters jump to, and the ids of a
  selection of every song.
- `change-stream`: a change to every song (a first sync, a rescan) and to a thousand, with songs
  key-only against songs sent whole as before.
- `on-demand-pages`: an album, an artist's albums and a playlist opened from nothing through the
  on-demand collection, a change reaching an album page that is open, and the heap after a thousand
  album pages were opened and closed.
- `albums`: the albums, which the renderer reads from main as it does the songs: the pages of the
  albums page, the artists with albums of their own, the cover ids of the albums of a list's rows, and
  an album's and an artist's page through the on-demand collection.

```
pnpm --filter @muswag/tests test:songs-benchmark
```

The libraries are copies of `apps/desktop/dev-library.db` (or `MUSWAG_BENCH_SOURCE`) with its songs and
albums repeated under new ids until there are enough, made once in the temp directory and migrated by
the app's layer when opened. The mirror server and client are the app's own, in one process, joined by
a transport that copies every message with V8's serializer the way Electron's IPC does; main's own reads
are copied the same way. `apps/desktop/scripts/ipc-benchmark.mjs` measures the real IPC in Electron.

| Variable                  | Default                    |                                        |
| ------------------------- | -------------------------- | -------------------------------------- |
| `MUSWAG_BENCH_SIZES`      | `4358,25000,100000,250000` | Library sizes, in songs                |
| `MUSWAG_BENCH_LATENCY_MS` | `0`                        | Added to each request and pushed batch |
| `MUSWAG_BENCH_OUT`        | temp directory             | Where the results are written as JSON  |

Heap sizes are the JS heap after garbage collection, so they leave out SQLite's own memory. Main and the
renderer share the process here; main holds nothing between requests, so the heap is the renderer's.
