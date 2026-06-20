import Fuse from "fuse.js";
import type { Album, MuswagDb, Song } from "./database.js";
import { eq, queryOnce } from "@tanstack/db";

export type SearchResultSong = {
  type: "song";
  coverArtPath: Album["coverArtPath"];
} & Pick<Song, "id" | "albumId" | "artist" | "artistId" | "album" | "year" | "title">;

export type SearchResultAlbum = { type: "album" } & Pick<Album, "id" | "artist" | "artistId" | "coverArtPath" | "year" | "name">;

export type SearchResult = SearchResultSong | SearchResultAlbum;

const toAlbum = ({ id, artistId, artist, coverArtPath, year, name }: Album): SearchResult => ({
  type: "album",
  id,
  artist,
  artistId,
  coverArtPath,
  year,
  name,
});

const toSong = ({ id, artistId, artist, year, title, albumId, album }: Song, albumData: Album): SearchResult => ({
  type: "song",
  id,
  artist,
  artistId,
  year,
  title,
  album,
  albumId,
  coverArtPath: albumData.coverArtPath,
});

export function CreateFuse(db: MuswagDb) {
  const f = new Fuse([] as SearchResult[], {
    keys: ["artist", "album", "title", "year", "name"],
    shouldSort: true,
    ignoreLocation: true,
    findAllMatches: true,
    threshold: 0.2,
  });

  db.albums.subscribeChanges(
    (v) => {
      for (const c of v) {
        console.log(toAlbum(c.value));
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
            f.remove((v) => v.type === "album" && v.id === c.value.id);
          }
          case "update": {
            const alb = await queryOnce((v) =>
              v
                .from({ a: db.albums })
                .where((v) => eq(v.a.id, c.value.albumId))
                .findOne(),
            );

            if (!alb) continue;

            f.remove((v) => v.type === "album" && v.id === c.value.id);
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

  return f;
}
