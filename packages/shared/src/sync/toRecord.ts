import type { AlbumWithSongsID3, Child } from "subsonic-api";

import type { Album, ArtistInfo, Song } from "../db/types.js";

function normalizeGenreValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null && "name" in value && typeof value.name === "string") {
    return value.name;
  }

  return String(value);
}

function toArtistInfo(artist: {
  id: string;
  name: string;
  coverArt?: string;
  artistImageUrl?: string;
  albumCount?: number;
  starred?: string;
  musicBrainzId?: string;
  sortName?: string;
  roles?: string[];
}): ArtistInfo {
  return {
    id: artist.id,
    name: artist.name,
    coverArt: artist.coverArt ?? null,
    artistImageUrl: artist.artistImageUrl ?? null,
    albumCount: artist.albumCount ?? null,
    starred: artist.starred ?? null,
    musicBrainzId: artist.musicBrainzId ?? null,
    sortName: artist.sortName ?? null,
    roles: artist.roles ?? [],
  };
}

export function toAlbumRecord(album: AlbumWithSongsID3, coverArtPath: string | null): Album {
  return {
    id: album.id,
    name: album.name,
    version: album.version ?? null,
    artist: album.artist ?? null,
    artistId: album.artistId ?? null,
    coverArt: album.coverArt ?? null,
    coverArtPath,
    songCount: album.songCount,
    duration: album.duration,
    playCount: album.playCount ?? null,
    created: album.created,
    starred: album.starred ?? null,
    year: album.year ?? null,
    genre: album.genre ?? null,
    played: album.played ?? null,
    userRating: album.userRating ?? null,
    musicBrainzId: album.musicBrainzId ?? null,
    displayArtist: album.displayArtist ?? null,
    sortName: album.sortName ?? null,
    originalReleaseDate: album.originalReleaseDate ?? null,
    releaseDate: album.releaseDate ?? null,
    isCompilation: album.isCompilation ?? null,
    explicitStatus: album.explicitStatus ?? null,
    recordLabels: (album.recordLabels ?? []).map((item) => ({ name: item.name })),
    genres: (album.genres ?? []).map((value) => ({ value: normalizeGenreValue(value) })),
    artists: (album.artists ?? []).map(toArtistInfo),
    releaseTypes: (album.releaseTypes ?? []).map((value) => ({ value })),
    moods: (album.moods ?? []).map((value) => ({ value })),
    discTitles: (album.discTitles ?? []).map((item) => ({ disc: item.disc, title: item.title })),
  };
}

export function toSongRecord(album: AlbumWithSongsID3, song: Child): Song {
  return {
    id: song.id,
    album: song.album ?? album.name,
    albumId: song.albumId ?? album.id,
    artist: song.artist ?? null,
    artistId: song.artistId ?? null,
    averageRating: song.averageRating ?? null,
    bitRate: song.bitRate ?? null,
    bookmarkPosition: song.bookmarkPosition ?? null,
    contentType: song.contentType ?? null,
    coverArt: song.coverArt ?? null,
    created: song.created ?? null,
    discNumber: song.discNumber ?? null,
    duration: song.duration ?? null,
    genre: song.genre ?? null,
    isDir: song.isDir,
    isVideo: song.isVideo ?? null,
    originalHeight: song.originalHeight ?? null,
    originalWidth: song.originalWidth ?? null,
    parent: song.parent ?? null,
    path: song.path ?? null,
    playCount: song.playCount ?? null,
    size: song.size ?? null,
    starred: song.starred ?? null,
    suffix: song.suffix ?? null,
    title: song.title,
    track: song.track ?? null,
    transcodedContentType: song.transcodedContentType ?? null,
    transcodedSuffix: song.transcodedSuffix ?? null,
    type: song.type ?? null,
    userRating: song.userRating ?? null,
    year: song.year ?? null,
    played: song.played ?? null,
    bpm: song.bpm ?? null,
    comment: song.comment ?? null,
    sortName: song.sortName ?? null,
    musicBrainzId: song.musicBrainzId ?? null,
    displayArtist: song.displayArtist ?? null,
    displayAlbumArtist: song.displayAlbumArtist ?? null,
    displayComposer: song.displayComposer ?? null,
    explicitStatus: song.explicitStatus ?? null,
    genres: (song.genres ?? []).map((value) => ({ value: normalizeGenreValue(value) })),
    artists: (song.artists ?? []).map(toArtistInfo),
    albumArtists: (song.albumArtists ?? []).map(toArtistInfo),
    contributors: (song.contributors ?? []).map((item) => ({
      role: item.role,
      subRole: item.subRole ?? null,
      artistId: item.artist?.id ?? null,
      artistName: item.artist?.name ?? null,
      coverArt: item.artist?.coverArt ?? null,
      artistImageUrl: item.artist?.artistImageUrl ?? null,
      albumCount: item.artist?.albumCount ?? null,
      starred: item.artist?.starred ?? null,
      musicBrainzId: item.artist?.musicBrainzId ?? null,
      sortName: item.artist?.sortName ?? null,
    })),
    moods: (song.moods ?? []).map((value) => ({ value })),
    replayGain: song.replayGain
      ? {
          trackGain: song.replayGain.trackGain ?? null,
          albumGain: song.replayGain.albumGain ?? null,
          trackPeak: song.replayGain.trackPeak ?? null,
          albumPeak: song.replayGain.albumPeak ?? null,
          baseGain: song.replayGain.baseGain ?? null,
          fallbackGain: song.replayGain.fallbackGain ?? null,
        }
      : null,
  };
}
