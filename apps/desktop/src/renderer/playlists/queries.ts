import { db } from "#/data/library";
import { appState } from "#/data/state";
import { rowStore } from "#/data/stores";
import type { PlaylistRow } from "#/playlists/rows";
import { IDLE_PLAYLIST_SYNC, type PlaylistEntry, type PlaylistSyncStatus } from "@muswag/model";
import { eq, inArray, useLiveQuery } from "@tanstack/react-db";
import { useSelector } from "@tanstack/react-store";
import { useMemo, useState } from "react";

export type PlaylistSummary = {
  id: string;
  name: string;
  comment: string;
  songCount: number;
  readonly: boolean;
  /** Created offline and not yet pushed to the server. */
  localOnly: boolean;
  owner: string | undefined;
};

const EMPTY_ENTRIES: readonly PlaylistEntry[] = [];
// `inArray` with an empty list is not a query TanStack DB can run, so an id no song has stands in for none.
const NO_SONGS = [" "];

export function usePlaylists() {
  const query = useLiveQuery({ queryKey: ["playlists"], query: (q) => q.from({ playlist: db.playlists }) });

  const playlists = useMemo((): PlaylistSummary[] => {
    return (
      (query.data ?? [])
        // `local: null` is a tombstone for a playlist awaiting deletion on the server.
        .flatMap(({ id, serverId, local }) =>
          local
            ? [
                {
                  id,
                  name: local.name,
                  comment: local.comment,
                  songCount: local.entries.length,
                  readonly: local.readonly,
                  localOnly: serverId === null,
                  owner: local.owner,
                },
              ]
            : [],
        )
        .sort((left, right) => left.name.localeCompare(right.name))
    );
  }, [query.data]);

  return { ...query, playlists };
}

export function usePlaylist(playlistId: string) {
  const recordQuery = useLiveQuery({
    queryKey: ["playlist", playlistId],
    query: (q) =>
      q
        .from({ playlist: db.playlists })
        .where(({ playlist }) => eq(playlist.id, playlistId))
        .findOne(),
  });

  const state = recordQuery.data?.local ?? null;
  const entries = state?.entries ?? EMPTY_ENTRIES;

  // The playlist's songs, which the songs collection reads from main for as long as the page is open.
  const songIds = useMemo(() => [...new Set(entries.map(({ songId }) => songId))], [entries]);
  const songsQuery = useLiveQuery({
    queryKey: ["playlist-songs", songIds],
    query: (q) => q.from({ song: db.songs }).where(({ song }) => inArray(song.id, songIds.length > 0 ? songIds : NO_SONGS)),
  });

  // Every change to the entries is another query, which reads its songs before it is ready. Until it is,
  // the songs of the last one that was stand in, so an edit does not take the page back to loading.
  const [shown, setShown] = useState<{ playlistId: string; songs: typeof songsQuery.data } | null>(null);
  if (songsQuery.isReady && (shown?.songs !== songsQuery.data || shown.playlistId !== playlistId)) setShown({ playlistId, songs: songsQuery.data });
  const songs = songsQuery.isReady ? songsQuery.data : shown?.playlistId === playlistId ? shown.songs : songsQuery.data;
  const loaded = songsQuery.isReady || shown?.playlistId === playlistId;
  const rows = useMemo((): PlaylistRow[] => {
    const byId = new Map(songs.map((song) => [song.id, song]));
    return entries.map(({ id, songId }) => ({ entryId: id, songId, song: byId.get(songId) ?? null }));
  }, [entries, songs]);

  return {
    record: recordQuery.data ?? null,
    state,
    rows,
    isLoading: recordQuery.isLoading || !loaded,
    isError: recordQuery.isError || songsQuery.isError,
  };
}

const playlistSyncRow = rowStore(appState.playlistSync, "playlist_sync");

/** The playlist sync main is running, whoever started it. */
export const usePlaylistSyncStatus = (): PlaylistSyncStatus => useSelector(playlistSyncRow, (row) => row?.value ?? IDLE_PLAYLIST_SYNC);
