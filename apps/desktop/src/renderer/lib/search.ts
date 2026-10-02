import type { Album, Artist, Song } from "@muswag/model";
import Fuse from "fuse.js";

import type { LibraryCollections } from "./db-renderer";

export type SearchResultSong = {
  type: "song";
  id: string;
  song: {
    coverArt: Album["coverArt"];
    coverArtPath: Album["coverArtPath"];
  } & Pick<Song, "id" | "albumId" | "artist" | "artistId" | "album" | "year" | "title">;
};

export type SearchResultAlbum = {
  type: "album";
  id: string;
  album: Pick<Album, "id" | "artist" | "artistId" | "coverArt" | "coverArtPath" | "year" | "name">;
};

export type SearchResultArtist = {
  type: "artist";
  id: string;
  artist: Pick<Artist, "id" | "name" | "coverArt" | "coverArtPath">;
};

export type SearchResult = SearchResultSong | SearchResultAlbum | SearchResultArtist;

const toAlbum = ({ id, artistId, artist, coverArt, coverArtPath, year, name }: Album): SearchResult => ({
  type: "album",
  id,
  album: {
    id,
    artist,
    artistId,
    coverArt,
    coverArtPath,
    year,
    name,
  },
});

const toSong = ({ id, artistId, artist, year, title, albumId, album }: Song, albumData: Album): SearchResult => ({
  type: "song",
  id,
  song: {
    id,
    artist,
    artistId,
    year,
    title,
    album,
    albumId,
    coverArt: albumData.coverArt,
    coverArtPath: albumData.coverArtPath,
  },
});

const toArtist = ({ id, name, coverArt, coverArtPath }: Artist): SearchResult => ({
  type: "artist",
  id,
  artist: {
    id,
    name,
    coverArt,
    coverArtPath,
  },
});

export function CreateFuse(db: Pick<LibraryCollections, "albums" | "artists" | "songs">) {
  const f = new Fuse([] as SearchResult[], {
    keys: ["song.artist", "song.album", "song.title", "song.year", "song.name", "album.artist", { name: "album.name", weight: 3 }, "album.year", { name: "artist.name", weight: 2 }],
    shouldSort: true,
    ignoreLocation: true,
    findAllMatches: true,
    threshold: 0.2,
    minMatchCharLength: 2,
  });

  db.albums.subscribeChanges(
    (v) => {
      for (const c of v) {
        switch (c.type) {
          case "delete": {
            f.remove((v) => v.type === "album" && v.id === c.value.id);
            break;
          }
          case "update": {
            f.remove((v) => v.type === "album" && v.id === c.value.id);
            f.add(toAlbum(c.value));
            break;
          }
          case "insert": {
            f.add(toAlbum(c.value));
            break;
          }
        }
      }
    },
    { includeInitialState: true },
  );

  const albumOf = (song: Song) => (song.albumId ? db.albums.get(song.albumId) : undefined);

  db.songs.subscribeChanges(
    (v) => {
      for (const c of v) {
        switch (c.type) {
          case "delete": {
            f.remove((v) => v.type === "song" && v.id === c.value.id);
            break;
          }
          case "update": {
            const alb = albumOf(c.value);
            if (!alb) continue;

            f.remove((v) => v.type === "song" && v.id === c.value.id);
            f.add(toSong(c.value, alb));
            break;
          }
          case "insert": {
            const alb = albumOf(c.value);
            if (!alb) continue;

            f.add(toSong(c.value, alb));
            break;
          }
        }
      }
    },
    { includeInitialState: true },
  );

  db.artists.subscribeChanges(
    (v) => {
      for (const c of v) {
        switch (c.type) {
          case "delete": {
            f.remove((v) => v.type === "artist" && v.id === c.value.id);
            break;
          }
          case "update": {
            f.remove((v) => v.type === "artist" && v.id === c.value.id);
            f.add(toArtist(c.value));
            break;
          }
          case "insert": {
            f.add(toArtist(c.value));
            break;
          }
        }
      }
    },
    { includeInitialState: true },
  );

  return f;
}
