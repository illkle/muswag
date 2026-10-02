import type { QueueSourceRef } from "@muswag/model";

import type { SourceItem, SourceRevision } from "#shared/queue-state";

export const SOURCE_BEHIND = 10;
export const SOURCE_AHEAD = 30;

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

export interface QueueSourceFactory {
  open(ref: QueueSourceRef): QueueSource;
}
