import Fuse from "fuse.js";
import type { Album, Artist, MuswagDb, Song } from "./database.js";
import { eq, queryOnce } from "@tanstack/db";

export type SearchResultSong = {
  type: "song";
  id: string;
  song: {
    coverArtPath: Album["coverArtPath"];
    coverArt: Album["coverArt"];
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
  artist: Pick<Artist, "id" | "name" | "coverArtPath" | "coverArt">;
};

export type SearchResult = SearchResultSong | SearchResultAlbum | SearchResultArtist;

const toAlbum = ({ id, artistId, artist, coverArt, coverArtPath, year, name }: Album): SearchResult => ({
  type: "album",
  id,
  album: {
    id,
    artist,
    artistId,
    coverArtPath,
    coverArt,
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
    coverArtPath: albumData.coverArtPath,
    coverArt: albumData.coverArt,
  },
});

const toArtist = ({ id, name, coverArtPath, coverArt }: Artist): SearchResult => ({
  type: "artist",
  id,
  artist: {
    id,
    name,
    coverArtPath,
    coverArt,
  },
});

export function CreateFuse(db: MuswagDb) {
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
          }
          case "update": {
            f.remove((v) => v.type === "album" && v.id === c.value.id);
            f.add(toAlbum(c.value));
          }
          case "insert": {
            f.add(toAlbum(c.value));
          }
        }
      }
    },
    { includeInitialState: true },
  );

  db.songs.subscribeChanges(
    async (v) => {
      for (const c of v) {
        switch (c.type) {
          case "delete": {
            f.remove((v) => v.type === "song" && v.id === c.value.id);
          }
          case "update": {
            const alb = await queryOnce((v) =>
              v
                .from({ a: db.albums })
                .where((v) => eq(v.a.id, c.value.albumId))
                .findOne(),
            );

            if (!alb) continue;

            f.remove((v) => v.type === "song" && v.id === c.value.id);
            f.add(toSong(c.value, alb));
          }
          case "insert": {
            const alb = await queryOnce((v) =>
              v
                .from({ a: db.albums })
                .where((v) => eq(v.a.id, c.value.albumId))
                .findOne(),
            );

            if (!alb) continue;

            f.add(toSong(c.value, alb));
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
          }
          case "update": {
            f.remove((v) => v.type === "artist" && v.id === c.value.id);
            f.add(toArtist(c.value));
          }
          case "insert": {
            f.add(toArtist(c.value));
          }
        }
      }
    },
    { includeInitialState: true },
  );

  return f;
}
