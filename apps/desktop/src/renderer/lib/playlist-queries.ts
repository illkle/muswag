import { db } from "#/lib/db-renderer";
import type { PlaylistRow } from "#/lib/playlist-queue";
import type { PlaylistEntry } from "@muswag/shared";
import { eq, inArray, useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";

export { totalDuration, type PlaylistRow } from "#/lib/playlist-queue";

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
  const query = useLiveQuery((q) => q.from({ playlist: db.playlists }));

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
  const recordQuery = useLiveQuery(
    (q) =>
      q
        .from({ playlist: db.playlists })
        .where(({ playlist }) => eq(playlist.id, playlistId))
        .findOne(),
    [playlistId],
  );

  const state = recordQuery.data?.local ?? null;
  const entries = state?.entries ?? EMPTY_ENTRIES;

  // Resolve only the songs this playlist references rather than reading the whole library.
  // An empty playlist would hand `inArray` an empty list, so match an id that cannot exist instead.
  const songIds = useMemo(() => {
    const unique = [...new Set(entries.map(({ songId }) => songId))];
    return unique.length > 0 ? unique : [" "];
  }, [entries]);
  const songIdKey = JSON.stringify(songIds);

  const songsQuery = useLiveQuery((q) => q.from({ song: db.songs }).where(({ song }) => inArray(song.id, songIds)), [songIdKey]);

  const rows = useMemo((): PlaylistRow[] => {
    const byId = new Map((songsQuery.data ?? []).map((song) => [song.id, song]));
    return entries.map(({ id, songId }) => ({ entryId: id, songId, song: byId.get(songId) ?? null }));
  }, [entries, songsQuery.data]);

  return {
    record: recordQuery.data ?? null,
    state,
    rows,
    isLoading: recordQuery.isLoading || songsQuery.isLoading,
    isError: recordQuery.isError || songsQuery.isError,
  };
}
