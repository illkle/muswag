# OpenSubsonic Table Plan

Source analyzed: `packages/opensubsonic-types/openapi/openapi.json` + generated types.

## Client-editable tables

These map to endpoints where the client can create/update/delete or otherwise mutate server state.

| Table | Why it exists | Main API signals |
|---|---|---|
| `playlists` | User playlists metadata | `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `getPlaylists`, `getPlaylist` (`Playlist`, `PlaylistWithSongs`) |
| `playlist_entries` | Ordered playlist tracks | `PlaylistWithSongs.entry` (`Child[]`) |
| `play_queues` | Persisted queue header (current track/position/changedBy) | `savePlayQueue`, `savePlayQueueByIndex`, `getPlayQueue`, `getPlayQueueByIndex` (`PlayQueue`) |
| `play_queue_entries` | Ordered queue tracks | `PlayQueue.entry` (`Child[]`) |
| `bookmarks` | Per-user resume/bookmark data | `createBookmark`, `deleteBookmark`, `getBookmarks` (`Bookmark`) |
| `ratings` | User rating per media entity | `setRating`; appears as `userRating` on `Child`/`AlbumID3` |
| `stars` | Star/favorite status per entity | `star`, `unstar`; appears as `starred` on artists/albums/songs |
| `scrobble_events` | Playback scrobble history/outbox (for offline retries) | `scrobble` |
| `shares` | Share links metadata | `createShare`, `updateShare`, `deleteShare`, `getShares` (`Share`) |
| `share_entries` | Items included in a share | `Share.entry` (`Child[]`) |
| `chat_messages` | Chat timeline authored by users | `addChatMessage`, `getChatMessages` (`ChatMessage`) |
| `internet_radio_stations` | User/admin-managed radio stations | `createInternetRadioStation`, `updateInternetRadioStation`, `deleteInternetRadioStation`, `getInternetRadioStations` |
| `podcast_channels` | Podcast subscriptions/channels managed by user/admin | `createPodcastChannel`, `refreshPodcasts`, `deletePodcastChannel`, `getPodcasts` (`PodcastChannel`) |
| `podcast_episodes` | Episodes under channels, incl. status | `getPodcasts`, `getNewestPodcasts`, `getPodcastEpisode`, `deletePodcastEpisode` (`PodcastEpisode`) |
| `users` | User records editable by admins (optional for non-admin clients) | `createUser`, `updateUser`, `deleteUser`, `getUser`, `getUsers` (`User`) |
| `user_folder_access` | User -> folder permission list | `User.folder` + user management endpoints |

## Library-derived tables

These are server-library snapshots (read models), not directly authored by client CRUD.

| Table | Why it exists | Main API signals |
|---|---|---|
| `artists` | Canonical artists | `getArtists`, `getArtist`, `search*`, `getStarred*` (`Artist`, `ArtistID3`) |
| `artist_roles` | Many roles per artist | `ArtistID3.roles` |
| `artist_info` | Extended biography/links/images | `getArtistInfo`, `getArtistInfo2` (`ArtistInfo`, `ArtistInfo2`) |
| `artist_similar` | Similar-artist graph | `ArtistInfo.similarArtist`, `ArtistInfo2.similarArtist` |
| `albums` | Canonical albums | `getAlbumList`, `getAlbumList2`, `getAlbum`, `search*`, `getStarred*` (`AlbumID3`) |
| `album_artists` | Many artists per album | `AlbumID3.artists` |
| `album_genres` | Many genres per album | `AlbumID3.genres` (`ItemGenre`) |
| `album_record_labels` | Labels per album | `AlbumID3.recordLabels` (`RecordLabel`) |
| `album_disc_titles` | Disc metadata per album | `AlbumID3.discTitles` (`DiscTitle`) |
| `songs` | Canonical tracks/media items | `getSong`, `getAlbum.song`, `getMusicDirectory`, `getRandomSongs`, `getTopSongs`, `getSongsByGenre`, `search*` (`Child`) |
| `song_artists` | Many artists per song | `Child.artists` |
| `song_album_artists` | Album-artist mapping at song level | `Child.albumArtists` |
| `song_contributors` | Contributor roles (composer, performer, etc.) | `Child.contributors` (`Contributor`) |
| `song_genres` | Many genres per song | `Child.genres` (`ItemGenre`) |
| `song_isrc_codes` | Multi-ISRC values per song | `Child.isrc` |
| `song_replay_gain` | ReplayGain numeric values | `Child.replayGain` |
| `genres` | Global genre aggregates | `getGenres` (`Genre`) |
| `music_folders` | Top-level library folder list | `getMusicFolders` (`MusicFolder`) |
| `directories` | Folder tree snapshot for browse mode | `getMusicDirectory` (`Directory`) |
| `directory_children` | Ordered children of directory nodes | `Directory.child` (`Child[]`) |
| `lyrics` | Plain lyrics blobs | `getLyrics`, `getLyricsBySongId` (`Lyrics`) |
| `structured_lyrics` | Per-language/synced lyrics header | `StructuredLyrics` |
| `structured_lyrics_lines` | Timed lines | `StructuredLyrics.line` (`Line`) |
| `videos` | Video library items | `getVideos` (`Videos`, `Child`) |
| `video_info` | Extended video metadata | `getVideoInfo` (`VideoInfo`) |
| `indexes` | Pre-grouped artist indexes/shortcuts metadata | `getIndexes`, `getArtists` (`Indexes`, `Index`, `ArtistsID3`) |
| `now_playing` | Current active sessions/players (derived live state) | `getNowPlaying` (`NowPlayingEntry`) |
| `scan_status` | Library scan state snapshots | `getScanStatus`, `startScan` (`ScanStatus`) |

## Cross-cutting/system tables (needed regardless of feature)

| Table | Why it exists |
|---|---|
| `sync_state` | Per-entity last sync cursors/timestamps and server capability flags |
| `sync_runs` | Observability for each sync pass (started/finished/error/counts) |
| `sync_tombstones` | Optional deletion tracking for reconcile jobs |
| `raw_payloads` | Optional debugging/audit cache for source JSON blobs |

## Practical rollout order

1. **Core library**: `artists`, `albums`, `songs` + join tables (`album_artists`, `song_artists`, `song_album_artists`, `genres`).
2. **User-state writebacks**: `playlists`, `playlist_entries`, `bookmarks`, `ratings`, `stars`, `play_queues`, `play_queue_entries`, `scrobble_events`.
3. **Extended metadata**: `artist_info`, `album_record_labels`, `album_disc_titles`, `lyrics`, `structured_lyrics*`.
4. **Optional/admin features**: `shares*`, `chat_messages`, `internet_radio_stations`, `podcast_*`, `users*`, `videos*`.

## Feature grouping

Legend: `[L]` = library-derived, `[C]` = client-editable, `[S]` = internal sync/system.

### Songs feature
- `songs` `[L]`
- `song_artists` `[L]`
- `song_album_artists` `[L]`
- `song_contributors` `[L]`
- `song_genres` `[L]`
- `song_isrc_codes` `[L]`
- `song_replay_gain` `[L]`
- `ratings` `[C]`
- `stars` `[C]`
- `scrobble_events` `[C]`
- `bookmarks` `[C]`
- `lyrics` `[L]`
- `structured_lyrics` `[L]`
- `structured_lyrics_lines` `[L]`

### Albums feature
- `albums` `[L]`
- `album_artists` `[L]`
- `album_genres` `[L]`
- `album_record_labels` `[L]`
- `album_disc_titles` `[L]`
- `ratings` `[C]`
- `stars` `[C]`

### Artists feature
- `artists` `[L]`
- `artist_roles` `[L]`
- `artist_info` `[L]`
- `artist_similar` `[L]`
- `stars` `[C]`

### Playlists feature
- `playlists` `[C]`
- `playlist_entries` `[C]`

### Queue / Playback state feature
- `play_queues` `[C]`
- `play_queue_entries` `[C]`
- `now_playing` `[L]`

### Library browse feature
- `music_folders` `[L]`
- `directories` `[L]`
- `directory_children` `[L]`
- `genres` `[L]`
- `indexes` `[L]`

### Sharing feature
- `shares` `[C]`
- `share_entries` `[C]`

### Social / Chat feature
- `chat_messages` `[C]`

### Radio feature
- `internet_radio_stations` `[C]`

### Podcasts feature
- `podcast_channels` `[C]`
- `podcast_episodes` `[C]`

### Video feature
- `videos` `[L]`
- `video_info` `[L]`

### User / Admin feature
- `users` `[C]`
- `user_folder_access` `[C]`

### Sync infrastructure feature
- `sync_state` `[S]`
- `sync_runs` `[S]`
- `sync_tombstones` `[S]`
- `raw_payloads` `[S]`
