import type { MuswagDb } from "./database.js";
import type { Album, AlbumDetail, AlbumRecord, GetSongsInput, Song, SongRecord } from "./types.js";

export function stripVirtualProps<T extends object>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith("$")) {
      result[key] = value;
    }
  }
  return result as T;
}

function stripAlbumMetadata(album: Album): AlbumRecord {
  const clean = stripVirtualProps(album);
  const { recordLabels: _, genres: _g, artists: _a, releaseTypes: _rt, moods: _m, discTitles: _dt, ...flat } = clean;
  return flat;
}

function stripSongMetadata(song: Song): SongRecord {
  const clean = stripVirtualProps(song);
  const { genres: _, artists: _a, albumArtists: _aa, contributors: _c, moods: _m, replayGain: _rg, ...flat } = clean;
  return flat;
}

export async function getAlbums(db: MuswagDb): Promise<AlbumRecord[]> {
  const albums: Album[] = [];
  for (const [, album] of db.albums.entries()) {
    albums.push(album);
  }

  albums.sort((a, b) => {
    const artistCmp = (a.artist ?? "").localeCompare(b.artist ?? "");
    if (artistCmp !== 0) return artistCmp;
    return a.name.localeCompare(b.name);
  });

  return albums.map(stripAlbumMetadata);
}

export async function getSongs(db: MuswagDb, input: GetSongsInput = {}): Promise<SongRecord[]> {
  const songs: Song[] = [];
  for (const [, song] of db.songs.entries()) {
    if (input.albumId && song.albumId !== input.albumId) continue;
    songs.push(song);
  }

  if (input.albumId) {
    songs.sort((a, b) => {
      const discCmp = (a.discNumber ?? 0) - (b.discNumber ?? 0);
      if (discCmp !== 0) return discCmp;
      const trackCmp = (a.track ?? 0) - (b.track ?? 0);
      if (trackCmp !== 0) return trackCmp;
      return a.title.localeCompare(b.title);
    });
  } else {
    songs.sort((a, b) => {
      const albumCmp = a.albumId.localeCompare(b.albumId);
      if (albumCmp !== 0) return albumCmp;
      const discCmp = (a.discNumber ?? 0) - (b.discNumber ?? 0);
      if (discCmp !== 0) return discCmp;
      const trackCmp = (a.track ?? 0) - (b.track ?? 0);
      if (trackCmp !== 0) return trackCmp;
      return a.title.localeCompare(b.title);
    });
  }

  return songs.map(stripSongMetadata);
}

export async function getSongById(db: MuswagDb, songId: string): Promise<SongRecord | null> {
  const song = db.songs.get(songId);
  if (!song) return null;
  return stripSongMetadata(song);
}

export async function getAlbumDetail(db: MuswagDb, albumId: string): Promise<AlbumDetail | null> {
  const album = db.albums.get(albumId);
  if (!album) return null;

  const songs = await getSongs(db, { albumId });

  return {
    album: stripAlbumMetadata(album),
    recordLabels: album.recordLabels.map((rl, position) => ({
      albumId,
      position,
      name: rl.name,
    })),
    genres: album.genres.map((g, position) => ({
      albumId,
      position,
      value: g.value,
    })),
    artists: album.artists.map((a, position) => ({
      albumId,
      position,
      id: a.id,
      name: a.name,
      coverArt: a.coverArt,
      artistImageUrl: a.artistImageUrl,
      albumCount: a.albumCount,
      starred: a.starred,
      musicBrainzId: a.musicBrainzId,
      sortName: a.sortName,
    })),
    releaseTypes: album.releaseTypes.map((rt, position) => ({
      albumId,
      position,
      value: rt.value,
    })),
    moods: album.moods.map((m, position) => ({
      albumId,
      position,
      value: m.value,
    })),
    discTitles: album.discTitles.map((dt, position) => ({
      albumId,
      position,
      disc: dt.disc,
      title: dt.title,
    })),
    songs,
  };
}
