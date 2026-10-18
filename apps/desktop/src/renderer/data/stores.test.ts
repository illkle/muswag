import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { describe, expect, it } from "vitest";

import { collectionStore, rowStore } from "#/data/stores";

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
