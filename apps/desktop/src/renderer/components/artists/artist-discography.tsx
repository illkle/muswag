import { PlayIcon, WarningIcon } from "@phosphor-icons/react";
import { artistOccurrenceKey, type LibraryAlbum as Album, type LibrarySong } from "@muswag/model";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { AlbumCover } from "#/components/album-list/album-cover";
import { PageState } from "#/components/page-state";
import { albumColumns, albumColumnsWithoutArtist } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import type { TrackListItem } from "#/components/track-list/types";
import { Button } from "#/components/ui/button";
import { getArtistCredits } from "#/components/utils/artist-links";
import { useMainRead } from "#/data/main-read";
import { LibraryActions } from "#/library/actions";
import { formatDuration, formatMetaLine } from "#/lib/format";
import { failureNotice } from "#/lib/notify";
import { QueueActions, usePlayingKey } from "#/queue/queue";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";

const COVER_SIZE = 128;
/** Above an album's cover, which keeps it apart from the tracks of the album before, or from the top bar over the first. */
const ALBUM_GAP = 28;
const FIRST_ALBUM_GAP = 12;
const COVER_TO_TRACKS = 12;

/** The artists something is credited to, as one comparable line. */
const creditLine = (credited: Parameters<typeof getArtistCredits>[0]) =>
  getArtistCredits(credited)
    .map(({ name }) => name)
    .join(", ");

const playArtist = (artistId: string, key: string) => void QueueActions.playSource({ type: "artist", artistId }, key).catch(failureNotice("The artist could not be played."));

/** What goes over an album's tracks: its cover, which opens the album, beside its name, details and a button that plays the artist from it. */
function AlbumBlock({ album, onPlay }: { album: Album; onPlay: () => void }) {
  const meta = formatMetaLine([
    album.year ? String(album.year) : null,
    `${album.songCount} track${album.songCount === 1 ? "" : "s"}`,
    formatDuration(album.duration),
    album.genre ?? album.genres?.[0]?.name ?? null,
  ]);

  return (
    <div className="flex h-full items-end gap-4 px-2" style={{ paddingBottom: COVER_TO_TRACKS }}>
      <Link
        to="/app/albums/$albumId"
        params={{ albumId: album.id }}
        aria-label={album.name}
        className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        style={{ width: COVER_SIZE }}
      >
        <AlbumCover className="w-full" size="thumbnail" target={{ type: "album", id: album.id, coverArtId: album.coverArt ?? null }} />
      </Link>

      <div className="flex min-w-0 flex-col items-start gap-1">
        <h2 className="line-clamp-2 text-xl font-semibold tracking-tight">{album.name}</h2>
        {meta ? <p className="text-sm text-muted-foreground">{meta}</p> : null}
        <Button size="sm" className="mt-1 gap-1.5" onClick={onPlay}>
          <PlayIcon weight="fill" />
          Play
        </Button>
      </div>
    </div>
  );
}

const NO_ALBUMS: ReadonlyArray<Album> = [];
const NO_SONGS: ReadonlyArray<LibrarySong> = [];

/** Every album of an artist, newest first, each with its tracks under its cover. Playing a track goes on through the albums after it. */
export function ArtistDiscography({ artistId }: { artistId: string }) {
  // The albums and their songs in the order main plays the artist in, which it reads with the same query.
  // Every song of the artist is a lot to read again while a sync changes songs, so it waits until they stop.
  const discographyQuery = useMainRead({ queryKey: ["discography", artistId], tables: ["albums", "songs"], read: () => LibraryActions.discography(artistId), quiet: true });

  const playingKey = usePlayingKey((ref) => ref.type === "artist" && ref.artistId === artistId);

  const albums = discographyQuery.data?.albums ?? NO_ALBUMS;
  const songs = discographyQuery.data?.songs ?? NO_SONGS;

  const items = useMemo((): TrackListItem[] => {
    const albumsById = new Map(albums.map((album) => [album.id, album]));
    const items: TrackListItem[] = [];
    // The songs come album by album, so an album starts where the song before was of another one.
    songs.forEach((song, index) => {
      const previous = songs[index - 1];
      const album = song.albumId ? albumsById.get(song.albumId) : undefined;
      if (!album) return;
      const key = artistOccurrenceKey(artistId, song.id);

      if (previous?.albumId !== song.albumId) {
        const gap = items.length === 0 ? FIRST_ALBUM_GAP : ALBUM_GAP;
        items.push({ type: "block", key: `album:${album.id}`, height: gap + COVER_SIZE + COVER_TO_TRACKS, content: <AlbumBlock album={album} onPlay={() => playArtist(artistId, key)} /> });
      }

      const disc = song.discNumber;
      if ((album.discTitles?.length ?? 0) > 1 && disc && (previous?.albumId !== song.albumId || previous.discNumber !== disc)) {
        const title = album.discTitles?.find((entry) => entry.disc === disc)?.title;
        items.push({ type: "heading", key: `disc:${album.id}:${disc}`, title: `Disc ${disc}`, ...(title ? { subtitle: title } : {}) });
      }

      items.push({ type: "track", key, song });
    });
    return items;
  }, [artistId, albums, songs]);

  if (discographyQuery.isPending) return <PageState tone="quiet" title="Loading albums…" />;
  if (discographyQuery.isError) {
    return <PageState tone="error" icon={<WarningIcon />} title="Albums unavailable" description="The artist's albums could not be read from the local database." />;
  }
  if (items.length === 0) return <PageState title="No albums" description="This artist has no albums of their own in the synced local library." />;

  // Naming the artist on every row only says something when a track is credited differently from its album.
  const albumCredits = new Map(albums.map((album) => [album.id, creditLine(album)]));
  const columns = songs.every((song) => creditLine(song) === albumCredits.get(song.albumId ?? "")) ? albumColumnsWithoutArtist : albumColumns;

  return (
    <TrackList
      items={items}
      columns={columns}
      playingKey={playingKey}
      onActivate={(item) => playArtist(artistId, item.key)}
      menu={(selection) => <TrackMenuAddItems selection={selection} />}
      scrollId={"artist-discography-" + artistId}
      topPadding={TOP_HEIGHT}
      bottomPadding={PLAYER_HEIGHT + 16}
    />
  );
}
