import type { LibraryAlbum, LibrarySong } from "@muswag/model";
import { describe, expect, it } from "vitest";

import { creditedAsTheirAlbums, discHeading } from "#/library/album-tracks";

const album = (id: string, fields: Partial<LibraryAlbum> = {}) => ({ id, name: id, artist: "Someone", artistId: "ar", ...fields }) as LibraryAlbum;
const song = (id: string, albumId: string, fields: Partial<LibrarySong> = {}) => ({ id, title: id, albumId, artist: "Someone", artistId: "ar", ...fields }) as LibrarySong;

describe("discHeading", () => {
  const twoDiscs = album("al", {
    discTitles: [
      { disc: 1, title: "" },
      { disc: 2, title: "Live" },
    ],
  });

  it("heads the first song of each disc, with the disc's title where it has one", () => {
    const songs = [song("a", "al", { discNumber: 1 }), song("b", "al", { discNumber: 1 }), song("c", "al", { discNumber: 2 })];
    expect(songs.map((each, index) => discHeading(twoDiscs, each, songs[index - 1]))).toEqual([
      { type: "heading", key: "disc:al:1", title: "Disc 1" },
      null,
      { type: "heading", key: "disc:al:2", title: "Disc 2", subtitle: "Live" },
    ]);
  });

  it("heads nothing on an album of one disc, or a song of no disc", () => {
    expect(discHeading(album("al", { discTitles: [{ disc: 1, title: "" }] }), song("a", "al", { discNumber: 1 }), undefined)).toBeNull();
    expect(discHeading(twoDiscs, song("a", "al", { discNumber: null }), undefined)).toBeNull();
  });

  it("heads the same disc again where another album's songs come before it", () => {
    expect(discHeading(twoDiscs, song("b", "al", { discNumber: 1 }), song("a", "other", { discNumber: 1 }))?.key).toBe("disc:al:1");
  });
});

describe("creditedAsTheirAlbums", () => {
  const albums = [album("al1"), album("al2", { artist: "Other", artistId: "ar2" })];

  it("holds while every song is credited as its own album is", () => {
    expect(creditedAsTheirAlbums([song("a", "al1"), song("b", "al2", { artist: "Other", artistId: "ar2" })], albums)).toBe(true);
  });

  it("fails for a song credited otherwise, or of an album not listed", () => {
    expect(creditedAsTheirAlbums([song("a", "al1", { artist: "Guest", artistId: "ar3" })], albums)).toBe(false);
    expect(creditedAsTheirAlbums([song("a", "missing")], albums)).toBe(false);
  });
});
