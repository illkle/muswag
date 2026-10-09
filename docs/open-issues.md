# Open issues

What the audit of `dev` in October 2026 found and that is still open. Everything fixed since is left out;
the history of those fixes is in the commits of 9 October 2026.

How to read an item:

- The id is the one the item had in the audit, so it can be found in the commit messages and in notes.
- The tag says what kind of item it is: `bug` (wrong behaviour), `gap` (a case nobody handles), `perf`,
  `security`, `dead` (unused code), `simplify` (works, but heavier than it needs to be), `release`,
  `test`, `docs`, `decision` (needs a call before any code).
- The size is a guess at the change: **S** under an hour, **M** an afternoon, **L** a day or more.
- "Suspected" means a link in the chain was not checked; everything else was traced in the code or
  reproduced in a test.

## 1. Queue and player

`apps/desktop/src/main/queue/`, `apps/desktop/src/main/player/`

- [ ] **N3 · `gap` · S — A track picked while the server refuses connections ends three tracks on.**
      A track is skipped only when it fails within twenty seconds of being started and had not played, so a
      slow failure, a stream that breaks and the track restored at start all stay where they are. Failures
      that come at once cannot be told from bad files, so those still move on, three times at most.
- [ ] **N4 · `gap` · S — Play is a disabled spinner for as long as a track loads.**
      Up to two minutes on a network that drops packets. Pause could be let through while loading.
- [ ] **N5 · `gap` · M — mpv 0.37, which Ubuntu 24.04 ships, is still rejected.**
      The minimum is 0.38.0 now, set by `loadfile … insert-at`. Supporting older ones means inserting with
      `append` and `playlist-move`, which could not be tried here.
- [ ] **N6 · `gap` · S — mpv installed as a snap is still found through PATH.**
      The Flatpak and snap wrappers are out of discovery and of the install suggestions, untested on Linux.

## 2. Library sync

`packages/backend/src/library/library-sync.ts`

- [ ] **L1 · `gap` · M — A sync that fails at startup is not tried again, and offline starts show "syncing" for a long time.**
      The client sets no request timeout and retries twice, so with the server unreachable the spinner runs
      and "Sync library" stays disabled until the OS gives up three times. After that the error is only in
      the menu, and nothing retries (playlists retry on their own). Needs the timeout of S1, and a retry,
      for instance when the playlist loop next succeeds.
- [ ] **L2 · `gap` · S — The quick sync at startup still cannot see changes to songs.**
      It skips an album whose counts, duration, name and artist are unchanged, so a retagged song or a new
      cover arrives only with a manual full sync. Add `coverArt` to the comparison at least, or run a full
      sync on a schedule.
- [ ] **L3 · `gap` · M — One album that fails aborts the whole sync, every time.**
      `Effect.forEach(…, { concurrency: 10 })` fails fast. If one album errors persistently, every sync stops
      there, the albums after it never sync and the deletion step never runs. No server response that
      triggers it is known today. Fix: catch per album, keep its id out of the deletions, report "N albums
      failed".
- [ ] **L4 · `gap` · S — A short page is taken for the last page.**
      A server that caps the page size below 500 would have the rest of its library treated as removed and
      deleted locally. Navidrome honours 500. Ending on an empty page costs one request.
- [ ] **L5 · `gap` · S — The time of the last sync is lost on restart, and shown nowhere.**
      `lastSyncedAt` is in memory only, although `sync_state` stores timestamps. The menu could show it.
- [ ] **L6 · `gap` · S — A sync asked for while another mode runs is rejected silently.**
      Reachable only before the mirrored status arrives, since the menu item is disabled while a sync runs.
- [ ] **L7 · `dead` · S — `sync_state.lastFullSyncAt` and `lastQuickSyncAt` are written and never read.**
      Use them for L5, or drop them.

## 3. Session and the Subsonic client

`packages/backend/src/session/`, `packages/backend/src/api/subsonic-api.ts`

- [ ] **S7 · `security` · S — The password is stored in plain text when no keychain is available.**
      Linux without a keyring. An accepted alpha decision; it should be in the README. Storing one salt and
      token pair in place of the password would be enough for Subsonic.

### Backend, found while fixing the rest

- [ ] **N8 · `bug` · M — A `createPlaylist` whose answer is lost still makes a second playlist.**
      Requests that change a playlist are no longer retried by the client, but the next pass creates again.
      A create that takes longer than the thirty seconds a request gets is a new way to lose the answer.
- [ ] **N9 · `gap` · S — A cover's file stays when its cover changed and the album is deleted before it is shown again.**
      Until logout. The quick sync at start also does not notice a changed cover (L2).
- [ ] **N10 · `gap` · S — A request that hangs is not retried.**
      The thirty seconds are for all attempts together. With L3 open, one `getAlbum` slower than that ends
      the whole library sync.
- [ ] **N11 · `gap` · S — A database from a newer build is not noticed.**
      It starts without complaint when it only has migrations this build does not know.

## 4. Main process and the process boundary

`apps/desktop/src/main/index.ts`, `window.ts`, `app-updater.ts`, `dev-bridge.ts`, `apps/desktop/src/preload/`

- [ ] **M1 · `decision` · S — Closing the window quits the app on macOS.**
      `window-all-closed` quits on every platform, which makes the `activate` handler dead. Since main owns
      everything, keeping the app (and the music) alive with the window closed on macOS is nearly free; it is
      a product choice. Otherwise delete the handler.

## 5. Renderer

`apps/desktop/src/renderer/`

### Simplifications

- [ ] **R14 · `simplify` · M — TanStack Query is used only as a holder for eight mutations.**
      With `@tanstack/react-router-ssr-query` to provide the client. A fifteen-line `useCommand` hook
      replaces both dependencies. TanStack Form serves one three-field login form.
- [ ] **R15 · `simplify` · M — About thirty live queries read tables of one row.**
      Every hook in `player/hooks.ts` creates its own. One `useRow(collection, key)` on
      `useSyncExternalStore` would replace them, and the per-row cover and album lookups.

### Dead code

- [ ] **R18 · `dead` · S — Files and exports nothing imports.**
      `components/debug-info.tsx`, `components/ui-custom/radio-tabs.tsx`, `components/ui/popover.tsx`,
      `components/ui/table.tsx`, `components/ui/input-group.tsx`; `usePlayerMpvAvailable`. In `ui/sidebar.tsx`
      the unused parts keep `separator`, `sheet`, `skeleton`, `tooltip` and `hooks/use-mobile.ts` alive.

### Found while fixing the rest

- [ ] **N12 · `perf` · S — The ordered Songs collection slows every later rewrite of the library.**
      About four times at 40k songs (a full sync, a logout), once Songs has been opened. Not felt at 4k.
      It could be released on logout or while a full sync runs.
- [ ] **N13 · `gap` · S — Small ones in the lists.**
      After a click on a row's play button the arrows scroll until the list has the focus again.
      Ctrl/Cmd+Shift+arrow moves without extending the selection. Thumbnails are made in the order asked
      for, so after a fast scroll the tiles in view wait behind those passed. Below 1024 px the queue lying
      over the page has an empty band at its top.
- [ ] **N14 · `gap` · S — The window's own background follows the OS, not the theme chosen in the app.**
      Visible at the window's edge while resizing with "Light" chosen on a dark OS.

## 6. Mirror package

`packages/tanstack-db-mirror/`

- [ ] **MI1 · `dead` · L — The path for writes from the renderer is unreachable.**
      Both servers and all thirteen collections are read-only, and nothing calls `applyTransaction`. That
      leaves the `mutate` request, the SQL for inserts, updates and deletes, the handling of column defaults,
      the memory server's mutations and `mutationTimeoutMs` without a caller: about 240 of 1,870 lines, about
      350 lines of tests and most of the fuzz tests' weight. The README still opens with "Renderer mutations
      are optimistic".
- [ ] **MI2 · `simplify` · L — Gap recovery, the heartbeat and epochs cannot trigger in this app.**
      A renderer registers its listener before `hello`, Electron neither drops nor reorders messages to a
      live frame, and a renderer never outlives main. `pull`, the pending queue, the five-second heartbeat,
      the epoch checks, the `__mirror_changes_meta` table and the retention of up to 20k changes run only in
      tests. Keep the gap check, have it reset, and delete log rows once they are broadcast: about 180 lines
      and 250 of tests. Writing the change log to a TEMP table as well would keep it out of the database file.
- [ ] **MI3 · `perf` · S — An upsert that changes nothing is captured and broadcast.**
      The update trigger has no `WHEN`, so a full library sync sends every album and song through
      `json_object`, the log, a decode and IPC, for the renderer to discard. A generated
      `WHEN OLD.c IS NOT NEW.c OR …` suppresses it.
- [ ] **MI4 · `bug` · S — Collections inherit TanStack DB's five-minute garbage collection.**
      A collection with no subscriber for five minutes is cleaned up, after which `awaitPosition` on it can
      only time out and a successful command would be reported as failed. Not hit today, because the sidebar,
      the player bar and the search index hold every collection. Default `gcTime: 0`.
- [ ] **MI5 · `gap` · S — One row that cannot be decoded makes its table unloadable.**
      The change stream skips such a row, the snapshot does not. Not reachable through Drizzle writes.
- [ ] **MI6 · `gap` · S — A migration that drops a column still meets stored triggers on a database that has not been opened by the current build.**
      The triggers are temporary now, and the ones stored earlier are dropped when the mirror starts, which
      is after the migrations. Only development databases have them. Open each once before shipping a
      migration that drops or renames a mirrored column, or drop the old triggers before migrating.
- [ ] **MI7 · `dead` · S — Unused surface.**
      The `./testing` export; the options `changeLogTable`, `retainChanges`, `flush`, `requestTimeoutMs`,
      `heartbeatMs`; `MemoryMirror.delete`, `get` and `rows`; the protocol version field.
      `awaitPosition` with a position from the other server either resets the client or resolves at once.
- [ ] **MI8 · `gap` · S — Snapshots are one unchunked synchronous pass.**
      About 75 ms of blocked main loop and a 5 MB message at 3,851 songs; roughly 1 s and 65 MB at 50k
      (extrapolated). Accept at this size.

## 7. Build, CI and release

`.github/workflows/`, `apps/desktop/electron-builder.yml`, the package manifests and configs

### Before a release

- [ ] **B1 · `release` · M — A release does not wait for CI, and `dev` is not checked by it.**
      CI runs on pull requests and on pushes to `master` only. A merge and a tag pushed together start CI
      and the release side by side, and the release job runs no lint or tests. Make the release job need
      the checks, add `dev` to the branches CI runs on, and launch one packaged build before a tag.
- [ ] **B2 · `release` · M — macOS builds are unsigned and arm64 only, and auto-update there probably cannot apply.**
      Squirrel.Mac requires a signed app, and the updater downloads automatically on every platform, so a Mac
      would fetch about 140 MB per release and then report an error (not tested on a Mac). Sign ad hoc
      (`mac.identity: "-"`), turn off the automatic download on macOS, and say "Apple Silicon only" or add
      x64.
- [ ] **B3 · `release` · S — The mpv minimum against what Linux ships.**
      The release has a `.deb` and an AppImage, and Ubuntu 24.04's mpv 0.37 is still turned down (N5). The
      `.deb` declares no dependency on mpv either.
- [ ] **B4 · `release` · S — CI skips the format check, the production build and the integration tests.**
      The three Vite builds first run in the release job. The integration tests skip themselves when Docker
      or ffmpeg is missing and would report green; the Navidrome image is `latest`.
- [ ] **B5 · `release` · S — Smaller release items.**
      A tag like `v1.2.3-beta.1` is accepted and published as the latest release. `releaseType: draft` does
      nothing under `--publish never`. `apps/desktop/package.json` says 0.1.0 while the latest release is
      0.3.1. The actions are on floating tags and `ubuntu-latest`. Users of 0.3.1 arrive logged out with
      their old `muswag.db` orphaned, which wants a release note. The maintainer email differs between
      `electron-builder.yml` and `package.json`.

### Bundle and tooling

- [ ] **B6 · `simplify` · S — The packaged app carries about 40 MB of `effect`, and every source map.**
      `effect` is external to the main bundle and a production dependency, so its sources, builds and maps
      are copied into the archive. Bundled, main is 1.7 MB (built, not run). Exclude `out/**/*.map`.
- [ ] **B7 · `simplify` · M — Three packages build a `dist` nothing consumes.**
      Every consumer resolves the `source` condition. Making `model`, `backend` and `tanstack-db-mirror`
      source-only removes three `tsconfig.build.json` files, the build scripts, `customConditions` and the
      resolution block copied into four vitest configs.
- [ ] **B8 · `dead` · S — Dependencies and config that do nothing.**
      `date-fns` and `@effect/platform-browser` are imported nowhere. `oxlint-tsgolint` is installed and
      type-aware linting never enabled. `@tanstack/devtools-vite` is loaded with no devtools UI mounted. The
      `postinstall` runs `electron-builder install-app-deps` with no native dependency left.
      `allowBuilds.msgpackr-extract` is not in the lockfile. `packages/backend/src/api/requests.http` has a
      broken login URL.
- [ ] **B9 · `dead` · S — Leftovers on disk and in ignore files.**
      Untracked: `.turbo/` (901 MB), `apps/desktop/dist/` (335 MB), `packages/shared/`,
      `packages/subsonic-api/`, `apps/desktop/dev.db*`. Tracked references to removed things in `.gitignore`,
      `.vscode/settings.json` and `apps/desktop/.gitignore`.
- [ ] **B10 · `simplify` · S — The dev runner can be trimmed.**
      The main and preload Vite configs differ in five lines. `clean-out.ts` is fifteen lines for an
      `rm -rf`, `start.ts` fifty for `electron .`. Keep the runner itself until electron-vite supports Vite 8
      in a stable release.
- [ ] **B11 · `docs` · S — The root README covers only the macOS workaround.**
      No prerequisites (Node 26, pnpm 11, mpv) and no instructions to run.

### Found while fixing the rest

- [ ] **N16 · `gap` · S — The dev runner stays alive after Electron exits cleanly.**
      `scripts/dev.ts` closes the dev server and then does not exit.

## 8. Tests

- [ ] **T1 · `test` · S — Main and backend are tested on Node 26 and run on Node 24.**
      Electron 44.5 bundles Node 24.21, while types and unit tests use Node 26. An API that only Node 25 or 26
      has would pass and then fail in the app. Pin `@types/node` to 24 for main and backend, or note it.
- [ ] **T2 · `test` · M — `packages/tests` is a package for three files, about 40% of them dead.**
      Every caller uses the tagged-template mode, so the per-track ffmpeg branch never runs.
      `createTempCoverArtDir`, `TempDir` and two timeout options have no users. The "benchmark" asserts no
      timing and needs no container. Committing a silent mp3 and a jpg as fixtures would leave Docker as the
      only requirement. The two integration files could live in `packages/backend`.
- [ ] **T3 · `test` · S — Coverage is not run in CI and leaves untested files out of its report.**
      The desktop config has no `coverage.include`.
- [ ] **N17 · `test` · S — Skipping a real unplayable track, the reset dialog, a failure notice, the guard that ends mpv on Windows, and anything else on Windows or Linux.**
      Covered by unit tests, some over the real player with an in-memory mpv. The machine these were made on
      has no display to click a native dialog.
