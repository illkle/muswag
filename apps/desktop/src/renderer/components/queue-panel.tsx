import { QueueIcon } from "@phosphor-icons/react";
import type { PlaybackItem, QueueSourceRef } from "@muswag/model";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { createStore, useStore } from "@tanstack/react-store";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";

import { SongListCoverLoader, formatDuration } from "#/components/song-list";
import { Button } from "#/components/ui/button";
import { ArtistLinks } from "#/components/utils/artist-links";
import { db } from "#/data/library";
import { cn } from "#/lib/utils";
import { useQueueManagerState } from "#/queue/queue";

const STORAGE_KEY = "muswag-queue-panel-open";
const HEADING_HEIGHT = 32;
const ITEM_HEIGHT = 48;

/** Whether the panel is showing. A preference of this window rather than app state, so it stays in the renderer. */
const panelOpen = createStore(localStorage.getItem(STORAGE_KEY) === "true");

function togglePanel() {
  panelOpen.setState((open) => !open);
  localStorage.setItem(STORAGE_KEY, String(panelOpen.state));
}

type Row = { type: "heading"; key: string; label: string } | { type: "item"; key: string; item: PlaybackItem; isPlaying: boolean };

/** The name of the album or playlist the queue is playing through. */
function useSourceName(ref: QueueSourceRef | null): string | null {
  const albumId = ref?.type === "album" ? ref.albumId : null;
  const playlistId = ref?.type === "playlist" ? ref.playlistId : null;

  const album = useLiveQuery(
    (q) =>
      albumId
        ? q
            .from({ album: db.albums })
            .where(({ album }) => eq(album.id, albumId))
            .findOne()
        : null,
    [albumId],
  ).data;
  const playlist = useLiveQuery(
    (q) =>
      playlistId
        ? q
            .from({ playlist: db.playlists })
            .where(({ playlist }) => eq(playlist.id, playlistId))
            .findOne()
        : null,
    [playlistId],
  ).data;

  return album?.name ?? playlist?.local?.name ?? null;
}

/** What is playing and what follows it, in playback order: the user queue plays before the source resumes. */
function useQueueRows(): Row[] {
  const queue = useQueueManagerState();
  const sourceName = useSourceName(queue.source?.ref ?? null);

  return useMemo(() => {
    const rows: Row[] = [];
    const section = (id: string, label: string, items: readonly PlaybackItem[], isPlaying = false) => {
      if (items.length === 0) return;
      rows.push({ type: "heading", key: id, label });
      for (const item of items) rows.push({ type: "item", key: `${id}:${item.key}`, item, isPlaying });
    };

    section("now", "Now playing", queue.nowPlaying ? [queue.nowPlaying] : [], true);
    section("user", "Next in queue", queue.userQueue);
    // Main keeps only a window of the source loaded, so this is the next stretch of it, not all of it.
    section("source", sourceName ? `Next from ${sourceName}` : "Next up", queue.source?.window.next ?? []);
    return rows;
  }, [queue, sourceName]);
}

const QueueItem = ({ item, isPlaying }: { item: PlaybackItem; isPlaying: boolean }) => {
  const { track } = item;

  return (
    <div className="grid h-12 w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 px-4">
      <div className="size-10">{track.albumId ? <SongListCoverLoader albumID={track.albumId} /> : <div className="size-10 rounded bg-muted" />}</div>
      <div className="flex flex-col overflow-hidden">
        <div className={cn("truncate text-sm", isPlaying && "font-bold")}>{track.title}</div>
        <ArtistLinks artist={track.artist} artistId={track.artistId} artists={track.artists} className="truncate text-xs text-muted-foreground" linkClassName="hover:text-foreground hover:underline" />
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">{formatDuration(track.duration)}</div>
    </div>
  );
};

/** Shows or hides the queue panel. */
export function QueuePanelToggle() {
  const open = useStore(panelOpen);

  return (
    <Button size="icon-sm" variant="ghost" onClick={togglePanel} aria-label={open ? "Hide queue" : "Show queue"} aria-expanded={open} title="Queue">
      <QueueIcon className="size-4" />
    </Button>
  );
}

/** The playback queue as a column on the right of the window. It only shows the queue; nothing in it changes it. */
export function QueuePanel() {
  const open = useStore(panelOpen);
  return open ? <QueuePanelContent /> : null;
}

function QueuePanelContent() {
  const rows = useQueueRows();
  const scrollRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === "heading" ? HEADING_HEIGHT : ITEM_HEIGHT),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 10,
    paddingEnd: 8,
  });

  return (
    <aside aria-label="Queue" className="flex h-(--main-height) w-72 shrink-0 flex-col border-l bg-sidebar text-sidebar-foreground">
      <div className="app-drag-region flex h-(--top-height) shrink-0 items-center px-4 text-sm font-medium">Queue</div>

      <div ref={scrollRef} className="scrollbar scrollbar-flush min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? <p className="px-4 py-1 text-xs text-sidebar-foreground/60">Nothing is playing.</p> : null}

        <div style={{ height: `${rowVirtualizer.getTotalSize()}px` }} className="relative w-full">
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!;

            return (
              <div key={row.key} style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }} className="absolute top-0 left-0 flex w-full">
                {row.type === "heading" ? (
                  <div className="flex h-8 w-full items-center px-4 text-xs font-medium text-sidebar-foreground/70">
                    <span className="truncate">{row.label}</span>
                  </div>
                ) : (
                  <QueueItem item={row.item} isPlaying={row.isPlaying} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
