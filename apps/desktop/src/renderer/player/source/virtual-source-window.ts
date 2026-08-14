import type { SourceCursor } from "@muswag/shared";

import { SOURCE_AHEAD, SOURCE_BEHIND, sourceWindowItems, type QueueSource, type SourceItem, type SourcePage, type SourceWindow } from "./queue-source";

const PAGE_SIZE = 30;

class RevisionChangedError extends Error {}

export class VirtualSourceWindow {
  private state: SourceWindow;
  private readonly source: QueueSource;
  private readonly behind: number;
  private readonly ahead: number;
  private readonly onChange?: (window: SourceWindow) => void;
  private generation = 0;
  private controller: AbortController;
  private unsubscribe: () => void = () => undefined;
  private invalidation = Promise.resolve();
  private disposed = false;

  private constructor(options: { source: QueueSource; cursor: SourceCursor; revision: string; behind: number; ahead: number; controller: AbortController; onChange?: (window: SourceWindow) => void }) {
    this.source = options.source;
    this.behind = options.behind;
    this.ahead = options.ahead;
    this.controller = options.controller;
    this.onChange = options.onChange;
    this.state = { revision: options.revision, cursor: options.cursor, previous: [], current: null, next: [] };
  }

  static async create(options: {
    source: QueueSource;
    start: { key: string } | { cursor: SourceCursor };
    behind?: number;
    ahead?: number;
    signal?: AbortSignal;
    onChange?: (window: SourceWindow) => void;
  }): Promise<VirtualSourceWindow> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const start = options.start;
      const shared = { source: options.source, behind: options.behind ?? SOURCE_BEHIND, ahead: options.ahead ?? SOURCE_AHEAD, controller, onChange: options.onChange };
      let window: VirtualSourceWindow;
      if ("key" in start) {
        const location = await options.source.locate({ key: start.key, signal: controller.signal });
        if (!location) throw new Error(`Source occurrence ${start.key} does not exist.`);
        window = new VirtualSourceWindow({ ...shared, cursor: { type: "item", key: start.key, offset: location.offset }, revision: location.revision });
      } else {
        // A restored cursor carries no revision of its own, so it is anchored against the live source first.
        window = new VirtualSourceWindow({ ...shared, cursor: { ...start.cursor }, revision: "" });
        await window.resyncCursor(controller.signal);
      }
      await window.refill();
      window.unsubscribe = options.source.subscribe(() => {
        void window.invalidate().catch((cause) => console.error("[queue] source invalidation failed", cause));
      });
      return window;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  get snapshot(): SourceWindow {
    return structuredClone(this.state);
  }

  get cursor(): SourceCursor {
    return { ...this.state.cursor };
  }

  get current(): SourceItem | null {
    return this.state.current ? structuredClone(this.state.current) : null;
  }

  has(key: string): boolean {
    return sourceWindowItems(this.state).some((item) => item.key === key);
  }

  async moveTo(key: string): Promise<SourceItem | null> {
    const known = sourceWindowItems(this.state).find((item) => item.key === key);
    const location = await this.source.locate({ key, signal: this.newGeneration() });
    if (location) {
      this.state = { ...this.state, cursor: { type: "item", key, offset: location.offset }, revision: location.revision };
    } else if (known) {
      this.state = { ...this.state, cursor: { type: "gap", offset: known.offset } };
    } else {
      return null;
    }
    await this.refill();
    this.publish();
    return this.state.current;
  }

  invalidate(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const signal = this.newGeneration();
    this.invalidation = this.invalidation
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed || signal.aborted) return;
        await this.resyncCursor(signal);
        if (signal.aborted) return;
        await this.refill();
        if (signal.aborted) return;
        this.publish();
      });
    return this.invalidation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.controller.abort();
    this.unsubscribe();
  }

  private newGeneration(): AbortSignal {
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    return this.controller.signal;
  }

  /** Re-anchors the cursor, and always the revision, against the source as it exists right now. */
  private async resyncCursor(signal: AbortSignal): Promise<void> {
    const cursor = this.state.cursor;
    if (cursor.type === "item") {
      const location = await this.source.locate({ key: cursor.key, signal });
      if (signal.aborted) return;
      if (location) {
        this.state = { ...this.state, cursor: { type: "item", key: cursor.key, offset: location.offset }, revision: location.revision };
        return;
      }
    }
    const probe = await this.source.read({ start: cursor.offset, end: cursor.offset, signal });
    if (signal.aborted) return;
    this.state = { ...this.state, cursor: { type: "gap", offset: cursor.offset }, revision: probe.revision };
  }

  private async refill(): Promise<void> {
    const generation = this.generation;
    const signal = this.controller.signal;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const next = await this.fillWindow(signal);
        if (this.disposed || signal.aborted || generation !== this.generation) return;
        this.state = next;
        return;
      } catch (cause) {
        if (!(cause instanceof RevisionChangedError) || signal.aborted) throw cause;
        await this.resyncCursor(signal);
      }
    }
    throw new Error("Source revision changed too frequently to fill its playback window.");
  }

  private async fillWindow(signal: AbortSignal): Promise<SourceWindow> {
    const { cursor, revision } = this.state;
    const read = async (start: number, end: number) => readPage(this.source, start, end, revision, signal);
    const currentPage = await read(cursor.offset, cursor.offset + 1);
    const current = cursor.type === "item" ? (currentPage.items.find(({ key }) => key === cursor.key) ?? null) : null;

    let previous: SourceItem[] = [];
    let behindEnd = cursor.offset;
    while (previous.length < this.behind && behindEnd > 0) {
      const start = Math.max(0, behindEnd - Math.max(PAGE_SIZE, this.behind));
      const page = await read(start, behindEnd);
      previous = [...page.items, ...previous].slice(-this.behind);
      behindEnd = start;
    }

    const next: SourceItem[] = [];
    let aheadStart = cursor.type === "gap" ? cursor.offset : cursor.offset + 1;
    let isEnd = false;
    while (next.length < this.ahead && !isEnd) {
      const page = await read(aheadStart, aheadStart + Math.max(PAGE_SIZE, this.ahead));
      next.push(...page.items.slice(0, this.ahead - next.length));
      isEnd = page.isEnd;
      aheadStart = page.nextOffset;
    }

    const window: SourceWindow = { revision, cursor: { ...cursor }, previous, current, next };
    const items = sourceWindowItems(window);
    if (new Set(items.map(({ key }) => key)).size !== items.length) throw new Error("Source occurrence keys must be unique across a filled window.");
    return window;
  }

  private publish(): void {
    this.onChange?.(this.snapshot);
  }
}

async function readPage(source: QueueSource, start: number, end: number, revision: string, signal: AbortSignal): Promise<SourcePage> {
  const page = await source.read({ start, end, signal });
  if (page.revision !== revision) throw new RevisionChangedError();
  if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset < start || page.nextOffset > end || (!page.isEnd && page.nextOffset <= start))
    throw new Error("Source page did not advance its next offset.");
  const keys = new Set<string>();
  let previousOffset = -1;
  for (const item of page.items) {
    if (!Number.isSafeInteger(item.offset) || item.offset < start || item.offset >= end) throw new Error("Source page returned an item outside its requested range.");
    if (item.offset <= previousOffset) throw new Error("Source page offsets must be ordered and unique.");
    if (keys.has(item.key)) throw new Error("Source page occurrence keys must be unique.");
    previousOffset = item.offset;
    keys.add(item.key);
  }
  return page;
}
