import { Db } from "@muswag/backend";
import { albums, artists, songs } from "@muswag/model";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createLibrary, type Library, syncLibrary } from "./helpers/effect-runtime.js";
import { type AlbumFixture, largeLibrary, librarySetA, librarySetB, songCount, variedLibrary } from "./library/fixtures.js";
import { forEachServer } from "./servers/index.js";

function readLibrary(library: Library) {
  return library.run(
    Effect.gen(function* () {
      const db = yield* Db;
      return { albums: yield* db.select().from(albums), artists: yield* db.select().from(artists), songs: yield* db.select().from(songs) };
    }),
  );
}

/** Every album's name with the titles of its songs, as the library has them. */
async function titles(library: Library) {
  const state = await readLibrary(library);
  const names = new Map(state.albums.map(({ id, name }) => [id, name]));
  return state.songs.map(({ albumId, title }) => `${names.get(albumId ?? "") ?? "?"} / ${title}`).sort();
}

const expectedTitles = (fixtures: readonly AlbumFixture[]) => fixtures.flatMap(({ title, songs }) => songs.map((song) => `${title} / ${song.title}`)).sort();

forEachServer((server, traits) => {
  let library: Library;
  beforeEach(() => {
    library = createLibrary();
  });
  afterEach(async () => {
    await library.dispose();
  });

  it("syncs every album, song and artist", async () => {
    await server().setLibrary(librarySetA);
    expect(await syncLibrary(library, server(), "full")).toBeNull();

    const state = await readLibrary(library);
    expect(state.albums.map(({ name }) => name).sort()).toEqual(librarySetA.map(({ title }) => title).sort());
    expect(await titles(library)).toEqual(expectedTitles(librarySetA));
    expect(state.songs.find(({ title }) => title === "Morning Grid")).toMatchObject({
      album: "Sky Patterns",
      artist: "Aurora Lane",
      track: 1,
      discNumber: 1,
      year: 2022,
      genre: "Indie",
      suffix: "mp3",
    });

    const artistIds = new Set(state.artists.map(({ id }) => id));
    expect(state.albums.every(({ artistId }) => artistId !== null && artistIds.has(artistId))).toBe(true);
  });

  it("keeps the artist of each song of a compilation", async () => {
    await server().setLibrary(librarySetA);
    expect(await syncLibrary(library, server(), "full")).toBeNull();

    const compilation = (await readLibrary(library)).songs.filter(({ album }) => album === "Summer Sampler");
    expect(compilation.map(({ artist }) => artist).sort()).toEqual(["June Pixel", "Mira Holt"]);
    expect(compilation.map(({ albumArtists }) => albumArtists?.map(({ name }) => name))).toEqual([["Various Artists"], ["Various Artists"]]);
  });

  it("syncs songs with and without ReplayGain, by several artists, on two discs and named outside ASCII", async () => {
    await server().setLibrary(variedLibrary);
    expect(await syncLibrary(library, server(), "full")).toBeNull();

    expect(await titles(library)).toEqual(expectedTitles(variedLibrary));
    const { songs } = await readLibrary(library);
    expect(songs.find(({ title }) => title === "Svefn-g-englar")?.replayGain?.trackGain).toBeCloseTo(-7.25);
    // Left out, or sent without values as Navidrome does.
    expect(songs.find(({ title }) => title === "Starálfur")?.replayGain?.trackGain).toBeUndefined();
    expect(songs.find(({ title }) => title === "Second Reel")).toMatchObject({ discNumber: 2, track: 1 });
    expect(songs.find(({ title }) => title === "Svefn-g-englar")?.musicBrainzId).toBe("0a7c1f7e-6a43-4b8e-9a51-6f0d1f1b2c01");
    const duet = songs.find(({ title }) => title === "Duet for Two");
    expect(duet?.artists?.map(({ name }) => name)).toEqual(traits.splitsArtists ? ["The Projectionists", "Ada Reel"] : ["The Projectionists"]);
    expect(duet?.albumArtists?.map(({ name }) => name)).toEqual(["The Projectionists"]);
  });

  for (const mode of ["full", "quick"] as const) {
    it(`takes in a library the server replaced, with a ${mode} sync`, async () => {
      await server().setLibrary(librarySetA);
      expect(await syncLibrary(library, server(), "full")).toBeNull();

      await server().setLibrary(librarySetB);
      expect(await syncLibrary(library, server(), mode)).toBeNull();

      const state = await readLibrary(library);
      expect(state.albums.map(({ name }) => name).sort()).toEqual(librarySetB.map(({ title }) => title).sort());
      expect(await titles(library)).toEqual(expectedTitles(librarySetB));
    });
  }

  it("removes a song deleted on the server, with a quick sync", async () => {
    await server().setLibrary(librarySetA);
    expect(await syncLibrary(library, server(), "full")).toBeNull();

    const withoutLateBus = librarySetA.map((album) => ({ ...album, songs: album.songs.filter(({ title }) => title !== "Late Bus") }));
    await server().setLibrary(withoutLateBus);
    expect(await syncLibrary(library, server(), "quick")).toBeNull();

    expect(await titles(library)).toEqual(expectedTitles(withoutLateBus));
  });

  // The same file with another title: the album looks as it did.
  const retagged = librarySetA.map((album) => ({ ...album, songs: album.songs.map((song) => (song.title === "Morning Grid" ? { ...song, title: "Morning Grid (Remastered)" } : song)) }));

  it("takes in a song the server retagged, with a full sync", async () => {
    await server().setLibrary(librarySetA);
    expect(await syncLibrary(library, server(), "full")).toBeNull();

    await server().setLibrary(retagged);
    expect(await syncLibrary(library, server(), "full")).toBeNull();
    expect(await titles(library)).toEqual(expectedTitles(retagged));
  });

  // A quick sync reads every song only when the server says it scanned since the last sync that did.
  it.runIf(traits.reportsLastScan)("takes in a song the server retagged, with a quick sync", async () => {
    await server().setLibrary(librarySetA);
    expect(await syncLibrary(library, server(), "full")).toBeNull();

    await server().setLibrary(retagged);
    expect(await syncLibrary(library, server(), "quick")).toBeNull();
    expect(await titles(library)).toEqual(expectedTitles(retagged));
  });

  it("reads a library of more albums and songs than a page holds", async () => {
    const large = largeLibrary(520, 2);
    await server().setLibrary(large);
    expect(await syncLibrary(library, server(), "full")).toBeNull();

    const state = await readLibrary(library);
    expect(state.albums).toHaveLength(large.length);
    expect(state.songs).toHaveLength(songCount(large));
  });
});
