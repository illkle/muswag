import { appCommand } from "#/data/app-command";
import { appState } from "#/data/app-state";
import { mainReadOptions, queryClient, useMainRead } from "#/data/main-read";
import type { PlaylistRow } from "#/playlists/rows";
import { IDLE_PLAYLIST_SYNC, type LibrarySong, type PlaylistEntry, type PlaylistSyncStatus, type PlaylistRow as PlaylistRecordRow } from "@muswag/model";
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
const NO_SONGS: ReadonlyArray<LibrarySong> = [];

/** Every playlist main has, read again whenever one changes. */
const playlistsRead = { queryKey: ["playlists"], tables: ["playlists"], read: () => appCommand("playlists:list") } as const;

/** The playlist `playlistId` as stored, or `undefined` when there is none: read from main, or from what was read last. */
export const readPlaylist = async (playlistId: string): Promise<PlaylistRecordRow | undefined> => (await queryClient.fetchQuery(mainReadOptions(playlistsRead))).find(({ id }) => id === playlistId);

export function usePlaylists() {
  const query = useMainRead(playlistsRead);

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
  // The playlist with its songs, read again whenever either changes. An edit keeps what was read until the new read is in.
  const query = useMainRead({ queryKey: ["playlist", playlistId], tables: ["playlists", "songs"], read: () => appCommand("playlists:get", playlistId) });
  const record = query.data?.playlist ?? null;
  const songs = query.data?.songs ?? NO_SONGS;

  const state = record?.local ?? null;
  const entries = state?.entries ?? EMPTY_ENTRIES;

  const rows = useMemo((): PlaylistRow[] => {
    const byId = new Map(songs.map((song) => [song.id, song]));
    return entries.map(({ id, songId }) => ({ entryId: id, songId, song: byId.get(songId) ?? null }));
  }, [entries, songs]);

  return {
    record,
    state,
    rows,
    isLoading: query.isPending,
    isError: query.isError,
  };
}

/** The playlist sync main is running, whoever started it. */
export const usePlaylistSyncStatus = (): PlaylistSyncStatus => useSelector(appState.playlistSync, (status) => status ?? IDLE_PLAYLIST_SYNC);
