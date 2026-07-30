# Playlist Integration Plan

Status: proposal. Covers wiring `packages/shared/src/playlists` into the desktop app, plus a review of the
existing playlist API with issues found along the way.

---

## 1. Where things stand

**Already done (shared package):**

- `packages/shared/src/playlists/types.ts` — `PlaylistRecord` = `{ id, serverId, base, local, revision }`, a
  base/local three-way-merge record. `local: null` is a tombstone.
- `packages/shared/src/playlists/controls.ts` — synchronous local mutations (`createPlaylist`, `renamePlaylist`,
  `setPlaylistComment`, `setPlaylistVisibility`, `addPlaylistEntry`, `removePlaylistEntry`, `movePlaylistEntry`,
  `deletePlaylist`).
- `packages/shared/src/playlists/merge.ts` — pure three-way merge producing next local state + remote mutations.
- `packages/shared/src/playlists/sync-manager.ts` — `createPlaylistSyncManager(db, options)`; debounced on local
  change, 5-min interval, abort on credential change, status subscription.
- `packages/shared/src/db/database.ts:50` — the `playlists` collection already exists in `createMuswagDb`, with
  indexes on `id` and `serverId`.
- `packages/shared/src/index.ts:8` — everything is already re-exported from `@muswag/shared`.
- Tests: `packages/tests/test/unit/playlist-{controls,merge,sync-manager}.test.ts` and
  `packages/tests/test/navidrome-playlist-sync.integration.test.ts`.

**Not done (the whole app side):** `grep -r playlist apps/desktop/src` returns nothing. No sync manager is ever
instantiated, no routes, no UI, no IPC. The `playlists` collection is created and persisted but always empty.

---

## 2. Review of the existing playlist API

Ordered by how much they should influence the integration work. Nothing here is a blocker for starting — but
items in 2.1 should be fixed *while* integrating, because the UI will expose them immediately.

### 2.1 Should fix as part of this work

**(a) `fetchRemotePlaylists` is an unbounded N+1 fan-out.**
`sync-manager.ts:66-70` calls `getPlaylists()` and then `Promise.all(summaries.map(getPlaylist))` — every
playlist, in parallel, on *every* pass. A pass runs 500 ms after any local edit, every 5 minutes, on login, and a
second time whenever there were remote mutations. With 80 playlists that's 160 concurrent requests per user
edit. Two independent fixes:
- Cap concurrency (a small `pMap`-style limiter, 4–6 in flight).
- Skip refetching unchanged playlists: `getPlaylists` summaries already carry `changed`, `songCount` and
  `duration` (`packages/subsonic-api/src/index.ts:179-193`). Cache the last-seen `changed`+`songCount` per
  `serverId` and only `getPlaylist` when it moved or when there is a pending local mutation for it.

**(b) The write-echo may double every sync pass.**
`applyLocalState` writes are suppressed from re-triggering sync via the synchronous `applyingLocalState` flag
(`sync-manager.ts:186, 223-227, 290`). But `db.playlists` is a *persisted* collection: the optimistic write emits
synchronously (suppressed) and the persistence layer confirms later, potentially emitting a second change event
after the flag is already `false` → `schedule(debounceMs)` → a redundant full pass (which, per (a), is another N
requests). **Verify this before shipping**; if confirmed, replace the flag with a check that ignores changes whose
resulting record already equals what sync wrote (or tag sync-originated writes via transaction metadata).

**(c) No bulk entry API.** Adding an album to a playlist means calling `addPlaylistEntry` 20 times, i.e. 20
`db.playlists.update` calls, 20 revision bumps, 20 change events, 20 persistence round-trips. Add:

```ts
export function addPlaylistEntries(db, playlistId, songIds: string[], beforeEntryId?: string | null): PlaylistEntry[]
```

Note the id scheme is a trap here: `addPlaylistEntry` mints `local:${playlistId}:${revision}`
(`controls.ts:98`), which is only unique because each call bumps the revision. A naive bulk version inside one
revision would mint N identical ids and silently corrupt the merge (which keys entirely off `entry.id`). Use
`local:${playlistId}:${revision}:${index}`, matching what `createPlaylist` already does at `controls.ts:54`.

**(d) Controls throw from inside the `update` draft callback.**
`addPlaylistEntry`/`removePlaylistEntry`/`movePlaylistEntry` (`controls.ts:101, 111, 126, 131`) throw
`Playlist entry not found` *inside* the `db.playlists.update(id, draft => ...)` mutator, after the draft has
possibly been partially mutated. Validate the entry ids against the current record *before* calling `update`, so a
bad id is a clean no-op rather than a half-applied transaction. (These are user-reachable: two windows, or a sync
pass replacing entry ids under a stale React render.)

**(e) `sync()` never rejects.** `startSync` swallows all errors into `status.error` (`sync-manager.ts:261-268`),
so a "Sync playlists now" button that `await`s it always looks successful. Either reject, or return the resulting
`PlaylistSyncStatus`. The UI needs the status subscription regardless, but a manual action should be able to
report its own failure.

**(f) Fixed 5-second retry, forever.** `retryAfter = retryMs` (`sync-manager.ts:267`) with no backoff and no cap.
A wrong password or a 500 means an N-request fan-out every 5 seconds indefinitely. Add exponential backoff
(5s → 10s → … → cap at ~5 min) and reset on success.

**(g) `readonly` is effectively dead code.** `controls.ts` refuses edits on read-only playlists and `merge.ts:139`
returns remote wholesale for them, but `readonly` is optional in the Subsonic schema
(`packages/subsonic-api/src/index.ts:191`) and Navidrome does not send it — so `toRemotePlaylist` defaults it to
`false` for everything, including playlists owned by other users. **Decide the intent:** either treat
`owner !== currentUsername` as read-only (requires plumbing the current username into `toRemotePlaylist`), or
accept that shared playlists are editable and let the server reject the write. Whichever way, the UI needs to know,
because right now it will render an Edit button on someone else's playlist.

### 2.2 Semantics the UI must be built around (not bugs, but they surface)

**(h) Every entry change rewrites the whole remote playlist.** The `replace` mutation removes all
`previousSongCount` songs by index and re-adds the full list (`sync-manager.ts:137-146`). Two consequences:
- *Correctness:* `previousSongCount` is captured at merge time. If another client changes the playlist between
  our `getPlaylists` fetch and our `updatePlaylist` call, we remove the wrong count — leftover or lost songs.
  Narrow window, but real. Mitigation: re-`getPlaylist` immediately before the replace and use the fresh count,
  or bail and let the next pass re-merge.
- *Size:* a one-song reorder in a 500-track playlist sends 500 indices + 500 ids. Works only because
  `defaultApiFactory` sets `post: true` (`sync-manager.ts:43`). Any custom `apiFactory` that forgets `post` will
  blow the URL limit. Worth asserting/documenting on the option.

**(i) At-least-once creates can produce visible duplicates.** If `createPlaylist` succeeds but the response is
lost, the next pass creates a second remote playlist with the same name (this is deliberate and tested —
`playlist-merge.test.ts:115`). The UI should not pretend this can't happen; a duplicate name is not an error state.

**(j) Remote-delete + local-edit resurrects the playlist** as a *new* server playlist with a new id
(`merge.ts:178-183`). Deleting a playlist on phone while the desktop has an unsynced rename brings it back.
Acceptable (safe direction), but should be understood.

**(k) Delete always wins over concurrent remote edits.** A local tombstone issues `delete` unconditionally
(`merge.ts:189-192`) regardless of what changed remotely.

**(l) Metadata conflicts are silent local-wins.** `mergeState` (`merge.ts:138-148`) takes local name/comment/public
when they differ from base. No conflict surfacing, which is fine, but it means "my rename overwrote yours" is
invisible.

### 2.3 Smaller notes

- `deletePlaylist` throws on read-only playlists (`controls.ts:138` → `getWritablePlaylist`). There is no way to
  hide/unsubscribe from a playlist you can't edit. Consider a local-only "hidden" flag if 2.1(g) lands.
- `applyLocalState` deletes while iterating `db.playlists.entries()` (`sync-manager.ts:107-111`). Snapshot the
  keys first.
- `sameRecord` is `JSON.stringify` comparison (`sync-manager.ts:77-79`) — correct only because every field is
  written in a fixed order by construction. Fragile if `PlaylistState` gains fields; a structural compare would be
  safer.
- `createPlaylist` (the mutation, `sync-manager.ts:120-134`) always follows up with `updatePlaylist` even when
  comment is `""` and public is `false` — one wasted request per create. Skip when both are defaults.
- `PlaylistState.duration` / `coverArt` / `changed` come from the server and are stale-by-design on locally-edited
  playlists. The UI should compute duration from the resolved local songs, not from `state.duration`.
- `movePlaylistEntry` returns `getWritablePlaylist(...)` on the no-op path (`controls.ts:120`), which still throws
  for a missing/read-only playlist — inconsistent with being a no-op, but harmless.

### 2.4 Two gaps that are really integration problems

**(m) Playlist entries are song *ids*; the player needs full `Song` objects.**
`PlayerIPC.playQueue` takes `{ queue: Song[], startIndex }` (`apps/desktop/src/shared/player.ts:7-10`). Playlist
entries only carry `songId`, so every playlist view must join against `db.songs`. But `db.songs` is populated by
the *album* sync (`sync/sync-albums.ts`) — a playlist created on another client can reference songs from albums
that were removed, filtered, or not yet synced. **The UI needs a defined behaviour for unresolvable entries**
(render a greyed "Unavailable track" row, keep the entry, skip it when building the play queue). Do not silently
drop them — they must survive a round-trip or the next sync will delete them server-side.

**(n) `SongListRoot` cannot represent duplicate songs.** Playlists explicitly support duplicates (the integration
test asserts it). But `apps/desktop/src/renderer/components/song-list/index.tsx` keys selection on `song.id`
(`:94-100`) and "is playing" on `song.id === currentTrackID` (`:101`). Two copies of the same track select and
highlight together. The list must be keyed by playlist *entry id*, which means threading an optional stable row
key through `SongListRoot` (it currently also uses `key={virtualRow.index}` at `:69`, which is wrong for reorders).

---

## 3. Integration plan

### Phase 0 — Shared-package fixes (do first)

Land 2.1(a)–(f) in `packages/shared/src/playlists`, with unit tests in `packages/tests/test/unit/`. These are
cheap now and expensive after there's UI depending on the current shapes.

- `controls.ts`: add `addPlaylistEntries`, pre-validate entry ids, fix the bulk id scheme.
- `sync-manager.ts`: concurrency-limited + `changed`-gated fetch, backoff, `sync()` surfacing failure, write-echo
  verification.
- Decide 2.1(g) (`readonly` / ownership) and thread `owner` comparison through if chosen.

Tests: `turbo run @muswag/tests#test`.

### Phase 1 — Wire the sync manager (no UI yet)

Create `apps/desktop/src/renderer/lib/playlist-sync.ts`, mirroring the existing `lib/sync-manager.ts` pattern:

```ts
import { db } from "#/lib/db-renderer";
import { createPlaylistSyncManager } from "@muswag/shared";

export const PlaylistSync = createPlaylistSyncManager(db);
```

Decisions to make here:

- **Renderer vs main process.** The renderer already owns a `MuswagDb` over the electron persistence bridge
  (`lib/db-renderer.ts:11`) and the album sync runs there, so renderer is consistent and simplest. Caveat: **exactly
  one instance must exist.** A second BrowserWindow would create a second manager racing on the same SQLite rows and
  producing duplicate remote creates. If multi-window is ever on the table, this belongs in `src/main` behind IPC
  instead. Recommend: renderer singleton now, with a comment stating the constraint.
- **Preload before first write.** `controls.ts` reads `db.playlists.get()` synchronously. The collection must be
  ready or every control call throws "Playlist not found". Call `await db.playlists.preload()` at module init
  (`Collection#preload`/`isReady` exist in `@tanstack/db@0.6.8`) and gate playlist UI on it. Also confirm the
  manager's own first pass can't run before the collection is loaded — if `queryOnce` doesn't await readiness,
  `applyLocalState` would see an empty local set and **delete unsynced offline playlists**. Add a unit test for
  "manager starts against a cold collection holding an unsynced create".
- Expose status via a hook in `lib/queries.ts`:
  `usePlaylistSyncStatus()` over `PlaylistSync.subscribe` + `useSyncExternalStore`.
- Call `PlaylistSync.destroy()` on window unload.

Verification for this phase is the existing integration test plus manual: log in, confirm server playlists appear
in the `playlists` table.

### Phase 2 — Read-only playlist UI

**Data layer** — `apps/desktop/src/renderer/lib/playlist-queries.ts`:

- `usePlaylists()` — live query over `db.playlists`, filter `local !== null`, sort by `local.name`. Returns
  `{ id, name, songCount, isLocalOnly: serverId === null, readonly }`.
- `usePlaylist(playlistId)` — the record plus resolved rows:
  `entries.map(e => ({ entryId: e.id, songId: e.songId, song: songsById.get(e.songId) ?? null }))`.
  Resolve via a live query over `db.songs` rather than `db.songs.get()` so it stays reactive. Handles 2.4(m).

**Routes** (file-based, `routeTree.gen.ts` is generated by the router plugin — don't hand-edit):

- `src/renderer/routes/app/playlists.tsx` — `<Outlet />` layout, mirroring `app/albums.tsx`.
- `src/renderer/routes/app/playlists.index.tsx` — playlist list; mirror `albums.index.tsx` structure
  (loading / error / empty / content blocks, `useUser()` guard).
- `src/renderer/routes/app/playlists.$playlistId.tsx` — header (name, comment, track count, computed duration,
  owner, "local only" badge) + song list; mirror `albums.$albumId.tsx`.

**Sidebar** — add a Playlists entry in `components/app-sidebar.tsx` (`ListMusic` from lucide) next to
Albums/Songs. Optionally list the playlists themselves as a `SidebarGroup` below.

**Song list changes** — extend `components/song-list/index.tsx` for 2.4(n):

- Add optional `rowKeys?: string[]` (or a `getRowKey(index)` prop) used for `key`, selection state and
  play-highlight, defaulting to `song.id` so albums/songs screens are unchanged.
- Add a `SongRenderPlaylist` variant: position number, cover, title/artist, album, duration, remove button.
- Add an `unavailable` rendering path for entries with no matching `db.songs` row.

**Playback** — `onSongPlay` builds the queue from resolved songs only, mapping the clicked entry index to the
filtered queue index (an unavailable entry earlier in the list must not offset `startIndex`).

### Phase 3 — Mutations

**Actions module** — `apps/desktop/src/renderer/lib/playlist-actions.ts`, thin wrappers over the shared controls
that catch and normalise errors (the controls throw synchronously) so components can use `useMutation` like
`top-bar.tsx` already does.

**UI surfaces:**

1. **Create playlist** — dialog (`components/ui/dialog.tsx` exists, base-ui flavoured) with name + comment +
   public toggle. Entry points: playlists index header, and "New playlist…" inside the add-to-playlist menu.
2. **Add to playlist** — needs a menu primitive that **does not exist yet**: there is no `dropdown-menu` or
   `context-menu` in `components/ui/`. Add one via shadcn (`components.json` style `base-vega`, aliases already
   configured) so it matches the base-ui components in use. Surfaces: song row (right-click / kebab), album page
   header ("Add all to playlist"), search results. Uses the new bulk `addPlaylistEntries`.
3. **Remove entry** — per-row action on the playlist detail page (`removePlaylistEntry`).
4. **Rename / edit comment / visibility** — inline or dialog on the playlist detail page.
5. **Delete playlist** — with confirmation. Note the tombstone semantics: for a server playlist the row stays with
   `local: null` until sync completes, so the list query must filter `local !== null` (already specified above).
6. **Reorder** — `movePlaylistEntry` exists but there is **no drag-and-drop library in the dependency list**.
   Recommend shipping v1 with move-up / move-down + keyboard (⌘↑/⌘↓) actions, and treating DnD as a follow-up that
   needs an explicit dependency decision (`@dnd-kit/*` or similar).

**Sync feedback** — a small status indicator (idle / syncing / error) sourced from `usePlaylistSyncStatus()`.
Given 2.1(e), a manual "Sync now" should show the real failure. Note that on the error-retry path `schedule()`
overwrites `state` with `"scheduled"` while keeping `error` non-null (`sync-manager.ts:205`), so the UI should key
"there is a problem" off `error !== null`, not off `state === "error"`.

### Phase 4 — Polish

- Playlist cover art (`state.coverArt` → the existing `muswag-cover` protocol path, or a 2×2 mosaic of member
  album covers).
- Playlists in fuzzy search (`packages/shared/src/db/fuzzy.ts` — add a `SearchResultPlaylist` variant and
  subscribe to `db.playlists`).
- "Add current queue as playlist" / "Play playlist" from the player panel.
- Empty/first-run states and a clear "this playlist has tracks not in your synced library" notice.

---

## 4. Testing

| Layer | Command | What to add |
|---|---|---|
| Shared unit | `turbo run @muswag/tests#test` | `addPlaylistEntries` (ids unique, ordering, anchor), pre-validation no-ops, backoff, concurrency limiting, cold-collection start not wiping unsynced creates, write-echo does not re-trigger sync |
| Integration | `turbo run @muswag/tests#test:integration` | extend `navidrome-playlist-sync.integration.test.ts` with concurrent-client replace and the stale-`previousSongCount` case from 2.2(h) |
| Desktop | `turbo run @muswag/desktop#test` | `song-list` row-key behaviour with duplicate songs; queue-index mapping with unavailable entries; playlist-actions error normalisation |

Integration tests need Docker + ffmpeg; they self-skip otherwise.

---

## 5. Decisions

1. **`readonly` / ownership** (2.1g) — a playlist is read-only when `owner !== currentUsername`. `toRemotePlaylist`
   takes the logged-in username (available from `getUserInfo(db)` in `runPass`) and derives `readonly` from it,
   OR-ed with any explicit `readonly` the server does send. Compare case-insensitively. A playlist with no `owner`
   field is treated as owned (not read-only). The UI hides edit/remove/delete affordances for read-only playlists;
   there is no "hide/unsubscribe" affordance (see 2.3 — the control layer can't express it).
2. **Sync manager location** — renderer, single instance, created in a dedicated module. A second BrowserWindow
   would race on the same rows; the constraint is documented at the instantiation site.
3. **Reorder** — deferred entirely. No move up/down and no DnD in this work; reordering lands in a later pass that
   covers moving songs across the app. `movePlaylistEntry` stays in the API, unused for now.
4. **Unavailable entries** — rendered as greyed-out rows showing the raw song id. The entry is preserved in the
   record and skipped when building the play queue.
5. **Remote fetch gating** (2.1a) — skip `getPlaylist` when the `getPlaylists` summary's `changed` + `songCount`
   match what we last saw, or when the playlist has a pending local mutation. The last-seen values come from the
   existing `record.base` (`base.changed` and `base.entries.length`) rather than a separate cache, so the gate
   survives restarts for free and an unchanged `RemotePlaylist` can be reconstructed from `base`. Because `changed`
   has second granularity, interval- and startup-triggered passes fetch everything unconditionally; only
   edit-triggered passes use the gate. Concurrency on the remaining fetches is still capped.
6. **Sync cadence** — 500 ms debounce kept, since (5) makes edit-triggered passes cheap.
