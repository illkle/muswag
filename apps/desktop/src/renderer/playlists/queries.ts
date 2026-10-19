import { db } from "#/data/library";
import { appState } from "#/data/state";
import { rowStore, useCollectionRows } from "#/data/stores";
import type { PlaylistRow } from "#/playlists/rows";
import { IDLE_PLAYLIST_SYNC, type PlaylistEntry, type PlaylistSyncStatus } from "@muswag/model";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { useSelector } from "@tanstack/react-store";
import { useMemo } from "react";

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

  // Each song is looked up by its key: an index on the key would cost the whole library a set per song.
  const songIds = useMemo(() => entries.map(({ songId }) => songId), [entries]);
  const songs = useCollectionRows(db.songs, songIds);

  const rows = useMemo((): PlaylistRow[] => entries.map(({ id, songId }, index) => ({ entryId: id, songId, song: songs.rows[index] ?? null })), [entries, songs.rows]);

  return {
    record: recordQuery.data ?? null,
    state,
    rows,
    isLoading: recordQuery.isLoading || !songs.isReady,
    isError: recordQuery.isError || songs.isError,
  };
}

const playlistSyncRow = rowStore(appState.playlistSync, "playlist_sync");

/** The playlist sync main is running, whoever started it. */
export const usePlaylistSyncStatus = (): PlaylistSyncStatus => useSelector(playlistSyncRow, (row) => row?.value ?? IDLE_PLAYLIST_SYNC);
