// @vitest-environment jsdom

import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { collectionStore, rowStore, useCollectionRows } from "#/data/stores";

type Row = { id: string; value: number };

const rows = (initialData: Row[]) => createCollection(localOnlyCollectionOptions({ getKey: ({ id }: Row) => id, initialData }));

describe("collection stores", () => {
  it("follow the deletion of a row that was there before they started", () => {
    const collection = rows([{ id: "a", value: 1 }]);
    const store = collectionStore([collection], () => collection.toArray.length);
    expect(store.get()).toBe(1);

    collection.delete("a");
    expect(store.get()).toBe(0);
  });

  it("follow one row through its changes and its deletion", () => {
    const collection = rows([{ id: "a", value: 1 }]);
    const store = rowStore(collection, "a");
    expect(store.get()?.value).toBe(1);

    collection.update("a", (row) => {
      row.value = 2;
    });
    expect(store.get()?.value).toBe(2);

    collection.delete("a");
    expect(store.get()).toBeUndefined();
  });
});

describe("useCollectionRows", () => {
  it("gives the rows of the keys in their order, and nothing for a key without one", () => {
    const collection = rows([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ]);
    const keys = ["b", "missing", "a", "b"];
    const { result } = renderHook(() => useCollectionRows(collection, keys));

    expect(result.current.isReady).toBe(true);
    expect(result.current.rows.map((row) => row?.value)).toEqual([2, undefined, 1, 2]);
  });

  it("follows the changes to its rows and keeps its result through changes to others", () => {
    const collection = rows([
      { id: "a", value: 1 },
      { id: "other", value: 0 },
    ]);
    const keys = ["a", "b"];
    const { result } = renderHook(() => useCollectionRows(collection, keys));
    const before = result.current;

    act(() => {
      collection.update("other", (row) => {
        row.value = 9;
      });
    });
    expect(result.current).toBe(before);

    act(() => {
      collection.update("a", (row) => {
        row.value = 2;
      });
      collection.insert({ id: "b", value: 3 });
    });
    expect(result.current.rows.map((row) => row?.value)).toEqual([2, 3]);

    act(() => {
      collection.delete("a");
    });
    expect(result.current.rows.map((row) => row?.value)).toEqual([undefined, 3]);
  });
});
