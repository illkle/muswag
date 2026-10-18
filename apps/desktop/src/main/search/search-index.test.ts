import Fuse from "fuse.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSearchIndex } from "./search-index";
import type { SearchedLibrary, SearchedRow } from "./searched-fields";

type Library = { albums: SearchedRow[]; artists: SearchedRow[]; songs: SearchedRow[] };

const library = (songs: SearchedRow[] = []): Library => ({
  albums: [{ id: "album-a", name: "Harvest", artist: "Someone", year: null }],
  artists: [{ id: "artist-a", name: "Harvester" }],
  songs,
});
const song = (id: string, title: string, fields: Partial<SearchedRow> = {}): SearchedRow => ({ id, title, artist: null, album: null, year: null, ...fields });

/** An index over `rows`, which reads whatever they hold at the time. */
const indexOf = (rows: Library) => {
  const read = vi.fn((): SearchedLibrary => structuredClone(rows));
  return { index: createSearchIndex(read), read };
};

const found = (hits: ReadonlyArray<{ type: string; id: string }>) => hits.map(({ type, id }) => `${type}:${id}`).sort();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the search index", () => {
  it("finds albums, artists and songs", () => {
    const { index } = indexOf(library([song("song-a", "Harvest Moon")]));

    expect(found(index.search("harvest", 20))).toEqual(["album:album-a", "artist:artist-a", "song:song-a"]);
  });

  it("answers a search of one character", () => {
    const { index } = indexOf(library([song("song-a", "愛"), song("song-b", "Other")]));

    expect(found(index.search("愛", 20))).toEqual(["song:song-a"]);
  });

  it("finds what the library holds at the time of the search, once it has been told of the changes", () => {
    const rows = library([song("song-a", "Cortez")]);
    const { index } = indexOf(rows);
    expect(found(index.search("cortez", 20))).toEqual(["song:song-a"]);

    rows.songs.push(song("song-b", "Cortez the Killer"));
    index.changed([{ table: "songs", type: "upsert", value: song("song-b", "Cortez the Killer") }]);
    expect(found(index.search("cortez", 20))).toEqual(["song:song-a", "song:song-b"]);

    rows.songs[0] = song("song-a", "Zuma");
    index.changed([{ table: "songs", type: "upsert", value: song("song-a", "Zuma") }]);
    expect(found(index.search("cortez", 20))).toEqual(["song:song-b"]);
    expect(found(index.search("zuma", 20))).toEqual(["song:song-a"]);

    rows.songs.length = 0;
    rows.albums.length = 0;
    rows.artists.length = 0;
    index.changed([
      { table: "songs", type: "delete", key: "song-a" },
      { table: "songs", type: "delete", key: "song-b" },
      { table: "albums", type: "delete", key: "album-a" },
      { table: "artists", type: "delete", key: "artist-a" },
    ]);
    expect(index.search("cortez", 20)).toEqual([]);
    expect(index.search("harvest", 20)).toEqual([]);
  });

  it("is built by a search and not by the changes before it, however many there are", () => {
    const songs = Array.from({ length: 500 }, (_, number) => song(`song-${number}`, `Song ${number}`));
    const rows = library(songs);
    const built = vi.spyOn(Fuse.prototype, "setCollection");
    const { index } = indexOf(rows);
    index.search("song", 20);
    built.mockClear();

    // A logout takes every row away.
    rows.songs = [];
    for (const { id } of songs) index.changed([{ table: "songs", type: "delete", key: id }]);
    expect(built).not.toHaveBeenCalled();

    expect(index.search("song", 20)).toEqual([]);
    index.search("song 1", 20);
    expect(built).toHaveBeenCalledTimes(1);
  });

  it("is not built again for a change to a field no search looks at, or to a table it does not search", () => {
    const { index } = indexOf(library([song("song-a", "Cortez")]));
    const built = vi.spyOn(Fuse.prototype, "setCollection");
    index.search("cortez", 20);
    built.mockClear();

    // What main sends holds only the searched fields, so a change to the play count comes as the same ones.
    index.changed([{ table: "songs", type: "upsert", value: song("song-a", "Cortez") }]);
    index.changed([{ table: "playlists", type: "upsert", value: { id: "playlist", name: "Cortez" } }]);
    index.changed([{ table: "songs", type: "delete", key: "song-never-indexed" }]);
    index.search("cortez", 20);
    expect(built).not.toHaveBeenCalled();

    index.changed([{ table: "albums", type: "upsert", value: { id: "album-a", name: "Zuma", artist: "Someone", year: null } }]);
    index.search("cortez", 20);
    expect(built).toHaveBeenCalledTimes(1);
  });

  it("is built ahead of the next search once the library has been quiet for a moment", () => {
    vi.useFakeTimers();
    const rows = library([song("song-a", "Cortez")]);
    const { index, read } = indexOf(rows);
    index.prepare();
    expect(read).toHaveBeenCalledTimes(1);

    // A sync goes on changing the library: the index waits for it to stop.
    index.changed([{ table: "songs", type: "upsert", value: song("song-b", "Cortez the Killer") }]);
    vi.advanceTimersByTime(900);
    index.changed([{ table: "songs", type: "upsert", value: song("song-c", "Cortez again") }]);
    vi.advanceTimersByTime(900);
    expect(read).toHaveBeenCalledTimes(1);
    rows.songs.push(song("song-b", "Cortez the Killer"), song("song-c", "Cortez again"));
    vi.advanceTimersByTime(100);
    expect(read).toHaveBeenCalledTimes(2);

    expect(found(index.search("cortez", 20))).toEqual(["song:song-a", "song:song-b", "song:song-c"]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
