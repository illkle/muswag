import { createStore, type Store } from "@tanstack/react-store";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

/** A collection, as far as following its changes goes. */
type Changing = { subscribeChanges: (callback: () => void, options: { includeInitialState: false }) => { unsubscribe: () => void } };
type Keyed<Row, Key> = Changing & { get: (key: Key) => Row | undefined };
/** A collection, as far as looking rows up by key, following which of them change, and its loading go. */
type KeyedLoading<Row, Key> = {
  get: (key: Key) => Row | undefined;
  subscribeChanges: (callback: (changes: ReadonlyArray<{ key: Key }>) => void, options: { includeInitialState: false }) => { unsubscribe: () => void };
  readonly status: string;
  on: (event: "status:change", callback: () => void) => () => void;
};

/** What hooks select from with `useSelector`. */
export type CollectionStore<T> = Pick<Store<T>, "get" | "subscribe">;

/**
 * What `read` makes of `collections`, worked out once per change however many components select from it.
 * A live query per hook would run a pipeline for each of them, and rebuild its query on every render.
 *
 * It subscribes to the collections, which starts their sync, the first time it is read, and stays subscribed:
 * this is the app's own state, which the window reads for as long as it is open.
 */
export function collectionStore<T>(collections: readonly Changing[], read: () => T): CollectionStore<T> {
  let store: Store<T> | undefined;
  const started = () => {
    if (store) return store;
    // Without `includeInitialState: false` a subscription hears nothing of the deletion of a row it was not told of.
    for (const collection of collections) collection.subscribeChanges(() => store?.setState(read), { includeInitialState: false });
    store = createStore<T>(read());
    return store;
  };
  return { get: () => started().get(), subscribe: (listener) => started().subscribe(listener) };
}

/** The row `key` of `collection`: `undefined` until the collection has loaded it, and while it has none. */
export const rowStore = <Row, Key>(collection: Keyed<Row, Key>, key: Key): CollectionStore<Row | undefined> => collectionStore([collection], () => collection.get(key));

/**
 * What `select` makes of the row `key` of `collection`, or `undefined` when the collection has no such row.
 * Reads nothing with a null `key`. Every change to the collection looks the row up again, which is cheap,
 * but `select` should return a value that stays the same while the row does, like one of its fields.
 */
export function useCollectionRow<Row, Key, T>(collection: Keyed<Row, Key>, key: Key | null, select: (row: Row) => T): T | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (key === null) return () => undefined;
      const subscription = collection.subscribeChanges(onChange, { includeInitialState: false });
      return () => subscription.unsubscribe();
    },
    [collection, key],
  );
  return useSyncExternalStore(subscribe, () => {
    const row = key === null ? undefined : collection.get(key);
    return row === undefined ? undefined : select(row);
  });
}

type KeyedRows<Row> = { readonly isReady: boolean; readonly isError: boolean; readonly rows: ReadonlyArray<Row | undefined> };

/**
 * The rows `keys` of `collection`, in the same order, with `undefined` for a key it has no row for, and
 * whether the collection has loaded. Each row is looked up by its key, so the collection needs no index
 * for it, and only a change to one of these rows renders again.
 */
export function useCollectionRows<Row, Key>(collection: KeyedLoading<Row, Key>, keys: readonly Key[]): KeyedRows<Row> {
  const wanted = useMemo(() => new Set(keys), [keys]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = collection.subscribeChanges(
        (changes) => {
          if (changes.some(({ key }) => wanted.has(key))) onChange();
        },
        { includeInitialState: false },
      );
      // A collection that loads with none of these rows, or fails to load, says so only here.
      const unsubscribeStatus = collection.on("status:change", onChange);
      return () => {
        subscription.unsubscribe();
        unsubscribeStatus();
      };
    },
    [collection, wanted],
  );
  // The snapshot has to stay the same object while nothing in it changes.
  const last = useRef<{ keys: readonly Key[]; status: string; value: KeyedRows<Row> }>(undefined);
  return useSyncExternalStore(subscribe, () => {
    const status = collection.status;
    const rows = keys.map((key) => collection.get(key));
    const previous = last.current;
    if (previous && previous.keys === keys && previous.status === status && previous.value.rows.every((row, index) => row === rows[index])) return previous.value;
    last.current = { keys, status, value: { isReady: status === "ready", isError: status === "error", rows } };
    return last.current.value;
  });
}
