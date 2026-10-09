import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { songRow, type Album, type Artist, type Song } from "@muswag/model";
import Fuse from "fuse.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSearchIndex } from "#/library/search";

const album = (id: string, name: string) => ({ id, name, artist: "Someone" }) as Album;
const artist = (id: string, name: string) => ({ id, name }) as Artist;

const library = (songs: Song[] = []) => ({
  albums: createCollection(localOnlyCollectionOptions({ getKey: ({ id }: Album) => id, initialData: [album("album-a", "Harvest")] })),
  artists: createCollection(localOnlyCollectionOptions({ getKey: ({ id }: Artist) => id, initialData: [artist("artist-a", "Harvester")] })),
  songs: createCollection(localOnlyCollectionOptions({ getKey: ({ id }: Song) => id, initialData: songs })),
});

const found = (results: ReturnType<ReturnType<typeof createSearchIndex>["search"]>) => results.map(({ type, id }) => `${type}:${id}`).sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the search index", () => {
  it("finds albums, artists and songs, the song of an album that is not in the library among them", () => {
    const index = createSearchIndex(library([songRow({ id: "song-a", title: "Harvest Moon", albumId: "album-gone" })]));

    expect(found(index.search("harvest", 20))).toEqual(["album:album-a", "artist:artist-a", "song:song-a"]);
  });

  it("answers a search of one character", () => {
    const index = createSearchIndex(library([songRow({ id: "song-a", title: "愛" }), songRow({ id: "song-b", title: "Other" })]));

    expect(found(index.search("愛", 20))).toEqual(["song:song-a"]);
  });

  it("finds what the library holds at the time of the search", () => {
    const collections = library([songRow({ id: "song-a", title: "Cortez" })]);
    const index = createSearchIndex(collections);
    expect(found(index.search("cortez", 20))).toEqual(["song:song-a"]);

    collections.songs.insert(songRow({ id: "song-b", title: "Cortez the Killer" }));
    expect(found(index.search("cortez", 20))).toEqual(["song:song-a", "song:song-b"]);

    collections.songs.update("song-a", (song) => {
      song.title = "Zuma";
    });
    expect(found(index.search("cortez", 20))).toEqual(["song:song-b"]);
    expect(found(index.search("zuma", 20))).toEqual(["song:song-a"]);

    collections.songs.delete(["song-a", "song-b"]);
    collections.albums.delete("album-a");
    collections.artists.delete("artist-a");
    expect(index.search("cortez", 20)).toEqual([]);
    expect(index.search("harvest", 20)).toEqual([]);
  });

  it("is built by a search and not by the changes before it, however many there are", () => {
    const songs = Array.from({ length: 500 }, (_, number) => songRow({ id: `song-${number}`, title: `Song ${number}` }));
    const collections = library(songs);
    const built = vi.spyOn(Fuse.prototype, "setCollection");
    const index = createSearchIndex(collections);
    built.mockClear();

    // A logout takes every row away, one change at a time.
    for (const { id } of songs) collections.songs.delete(id);
    expect(built).not.toHaveBeenCalled();

    index.search("song", 20);
    index.search("song 1", 20);
    expect(built).toHaveBeenCalledTimes(1);

    collections.songs.insert(songRow({ id: "song-new", title: "Song new" }));
    expect(found(index.search("new", 20))).toEqual(["song:song-new"]);
    expect(built).toHaveBeenCalledTimes(2);
  });
});
