import { describe, expect, it } from "vitest";

import { createCoverManager, type CoverArtStore } from "@muswag/shared";
import { albumWithSongsFixture } from "../fixtures/sync-fixtures.js";
import { createInMemoryDb } from "../navidrome-testkit.js";

function insertAlbum(db: ReturnType<typeof createInMemoryDb>, id: string, coverArt = `cover-${id}`, path?: string, source?: string) {
  const { song: _song, ...album } = albumWithSongsFixture({ id, coverArt });
  db.albums.insert({ ...album, coverArtPath: path, ...(source === undefined ? {} : { coverArtSourceId: source }) });
}

describe("cover manager", () => {
  it("sweeps albums and artists through namespaced keys", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "album-1");
    db.artists.insert({ id: "artist-1", name: "Artist", coverArt: "artist-cover" });
    const calls: string[] = [];
    const store: CoverArtStore = {
      async fetch(key) {
        calls.push(key);
        return `/covers/${encodeURIComponent(key)}.jpg`;
      },
      async remove() {},
    };
    const result = await createCoverManager({ db, store }).sweep();
    expect(calls.sort()).toEqual(["album:album-1", "artist:artist-1"]);
    expect(result).toEqual({ completed: 2, total: 2 });
  });

  it("deduplicates concurrent ensure calls", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "dedup");
    let calls = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const store: CoverArtStore = {
      async fetch() {
        calls += 1;
        return pending;
      },
      async remove() {},
    };
    const covers = createCoverManager({ db, store });
    const target = { type: "album" as const, id: "dedup", coverArtId: "cover-dedup" };
    const first = covers.ensure(target);
    const second = covers.ensure(target);
    release("/covers/dedup.jpg");
    expect(await Promise.all([first, second])).toEqual(["/covers/dedup.jpg", "/covers/dedup.jpg"]);
    expect(calls).toBe(1);
  });

  it("negative-caches failures and preserves an old path", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "negative", "new-source", "/covers/old.jpg", "old-source");
    let calls = 0;
    const store: CoverArtStore = {
      async fetch() {
        calls += 1;
        return undefined;
      },
      async remove() {},
    };
    const covers = createCoverManager({ db, store });
    const target = { type: "album" as const, id: "negative", coverArtId: "new-source" };
    expect(await covers.ensure(target)).toBe("/covers/old.jpg");
    expect(await covers.ensure(target)).toBe("/covers/old.jpg");
    expect(calls).toBe(1);
  });

  it("refetches when coverArtSourceId changes", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "changed", "new", "/covers/old.jpg", "old");
    const store: CoverArtStore = {
      async fetch() {
        return "/covers/new.jpg";
      },
      async remove() {},
    };
    await createCoverManager({ db, store }).ensure({ type: "album", id: "changed", coverArtId: "new" });
    expect(db.albums.get("changed")).toMatchObject({ coverArtPath: "/covers/new.jpg", coverArtSourceId: "new" });
  });

  it("repairs a known-bad path and removes it after the replacement is persisted", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "missing", "cover-missing", "/covers/missing.jpg", "cover-missing");
    const removed: string[] = [];
    const store: CoverArtStore = {
      async fetch() {
        return "/covers/repaired.jpg";
      },
      async remove() {},
      async removePath(path) {
        removed.push(path);
      },
    };

    const result = await createCoverManager({ db, store }).repair(
      { type: "album", id: "missing", coverArtId: "cover-missing" },
      "/covers/missing.jpg",
    );

    expect(result).toBe("/covers/repaired.jpg");
    expect(db.albums.get("missing")).toMatchObject({
      coverArtPath: "/covers/repaired.jpg",
      coverArtSourceId: "cover-missing",
    });
    expect(removed).toEqual(["/covers/missing.jpg"]);
  });

  it("clears a known-bad path when repair fails and negative-caches the retry", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "broken", "cover-broken", "/covers/broken.jpg", "cover-broken");
    let calls = 0;
    const store: CoverArtStore = {
      async fetch() {
        calls += 1;
        return undefined;
      },
      async remove() {},
    };
    const covers = createCoverManager({ db, store });
    const target = { type: "album" as const, id: "broken", coverArtId: "cover-broken" };

    expect(await covers.repair(target, "/covers/broken.jpg")).toBeNull();
    expect(db.albums.get("broken")?.coverArtPath).toBeUndefined();
    expect(await covers.ensure(target)).toBeNull();
    expect(calls).toBe(1);
  });

  it("ignores a stale image failure after the database points at a newer cover", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "fresh", "cover-fresh", "/covers/fresh.jpg", "cover-fresh");
    let calls = 0;
    const store: CoverArtStore = {
      async fetch() {
        calls += 1;
        return "/covers/unexpected.jpg";
      },
      async remove() {},
    };

    const result = await createCoverManager({ db, store }).repair(
      { type: "album", id: "fresh", coverArtId: "cover-fresh" },
      "/covers/stale.jpg",
    );

    expect(result).toBe("/covers/fresh.jpg");
    expect(db.albums.get("fresh")?.coverArtPath).toBe("/covers/fresh.jpg");
    expect(calls).toBe(0);
  });

  it("reconciles database paths missing from the cache during a sweep", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "reconcile", "cover-reconcile", "/covers/gone.jpg", "cover-reconcile");
    const calls: string[] = [];
    const store: CoverArtStore = {
      async fetch(key) {
        calls.push(key);
        return "/covers/restored.jpg";
      },
      async remove() {},
      async list() {
        return [];
      },
    };

    const result = await createCoverManager({ db, store }).sweep();

    expect(result).toEqual({ completed: 1, total: 1 });
    expect(calls).toEqual(["album:reconcile"]);
    expect(db.albums.get("reconcile")?.coverArtPath).toBe("/covers/restored.jpg");
  });

  it("prunes only unreferenced files", async () => {
    const db = createInMemoryDb();
    insertAlbum(db, "keep", "cover", "/covers/keep.jpg", "cover");
    const removed: string[] = [];
    const store: CoverArtStore = {
      async fetch() {
        return undefined;
      },
      async remove() {},
      async list() {
        return ["/covers/keep.jpg", "/covers/orphan.jpg"];
      },
      async removePath(path) {
        removed.push(path);
      },
    };
    expect(await createCoverManager({ db, store }).pruneOrphans()).toBe(1);
    expect(removed).toEqual(["/covers/orphan.jpg"]);
  });
});
