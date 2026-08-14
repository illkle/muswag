import type { PlaybackItem, QueueSourceRef, SourceCursor } from "#core";

export const SOURCE_BEHIND = 10;
export const SOURCE_AHEAD = 30;

export type SourceRevision = string;

export type SourceItem = PlaybackItem & {
  /** Absolute raw position in this source revision. */
  offset: number;
};

export type SourcePage = {
  revision: SourceRevision;
  nextOffset: number;
  items: SourceItem[];
  isEnd: boolean;
};

export type SourceLocation = { revision: SourceRevision; offset: number };

export interface QueueSource {
  readonly ref: QueueSourceRef;
  read(options: { start: number; end: number; signal: AbortSignal }): Promise<SourcePage>;
  locate(options: { key: string; signal: AbortSignal }): Promise<SourceLocation | null>;
  subscribe(listener: (revision: SourceRevision) => void): () => void;
}

export type SourceWindow = {
  revision: SourceRevision;
  cursor: SourceCursor;
  previous: readonly SourceItem[];
  current: SourceItem | null;
  next: readonly SourceItem[];
};

export interface QueueSourceFactory {
  open(ref: QueueSourceRef): QueueSource;
}

/** Everything the window has materialised, in playback order. */
export function sourceWindowItems(window: SourceWindow): SourceItem[] {
  return [...window.previous, ...(window.current ? [window.current] : []), ...window.next];
}
