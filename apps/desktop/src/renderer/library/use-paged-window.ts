import { useEffect, useState, useSyncExternalStore } from "react";

import { PagedWindow, type PagedWindowSource, type PagedWindowView } from "#/library/paged-window";

const NO_WINDOW = { subscribe: () => () => {}, getView: () => undefined };

/**
 * A window over what `source` reads, open while the component is and opened again for another source,
 * with its view, a new one after every page read. Both are `undefined` until the window has opened;
 * the window of an earlier source is not given out meanwhile.
 */
export function usePagedWindow<Row extends { readonly id: string }>(source: PagedWindowSource<Row>): { window: PagedWindow<Row> | undefined; view: PagedWindowView | undefined } {
  const [opened, setOpened] = useState<{ source: PagedWindowSource<Row>; window: PagedWindow<Row> } | undefined>(undefined);
  useEffect(() => {
    const window = new PagedWindow(source);
    setOpened({ source, window });
    return () => window.dispose();
  }, [source]);

  const window = opened?.source === source ? opened.window : undefined;
  const store = window ?? NO_WINDOW;
  const view = useSyncExternalStore(store.subscribe, store.getView);
  return { window, view: window ? view : undefined };
}
