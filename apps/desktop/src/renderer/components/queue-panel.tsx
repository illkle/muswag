import { QueueIcon } from "@phosphor-icons/react";
import type { PlaybackItem, QueueSourceRef } from "@muswag/model";
import { createStore, useStore } from "@tanstack/react-store";
import { useMemo } from "react";

import { compactColumns } from "#/components/track-list/columns";
import { songDragOf, TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import type { TrackListItem, TrackSelection } from "#/components/track-list/types";
import { Button } from "#/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "#/components/ui/context-menu";
import { db } from "#/data/library";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { useCollectionRow } from "#/data/stores";
import { failureNotice } from "#/lib/notify";
import { useSongDrop, type SongDrag } from "#/lib/song-drag";
import { cn } from "#/lib/utils";
import { QueueActions, useQueueManagerState } from "#/queue/queue";
import { TOP_HEIGHT } from "#/styles";

const STORAGE_KEY = "muswag-queue-panel-open";

/** Whether the panel is showing. A preference of this window rather than app state, so it stays in the renderer. */
const panelOpen = createStore(localStorage.getItem(STORAGE_KEY) === "true");

function togglePanel() {
  panelOpen.setState((open) => !open);
  localStorage.setItem(STORAGE_KEY, String(panelOpen.state));
}

/** What to call the album, playlist, artist or library the queue is playing through. */
function useSourceName(ref: QueueSourceRef | null): string | null {
  // The albums are read on demand, so the album playing is asked for rather than looked up.
  const albumId = ref?.type === "album" ? ref.albumId : null;
  const albumQuery = useLiveQuery({
    queryKey: ["queue-source-album", albumId],
    query: (q) =>
      albumId === null
        ? undefined
        : q
            .from({ album: db.albums })
            .where(({ album }) => eq(album.id, albumId))
            .findOne(),
  });
  const album = albumQuery.data?.name;
  const playlist = useCollectionRow(db.playlists, ref?.type === "playlist" ? ref.playlistId : null, ({ local }) => local?.name);
  const artist = useCollectionRow(db.artists, ref?.type === "artist" ? ref.artistId : null, ({ name }) => name);

  if (ref?.type === "library") return "your library";
  return album ?? playlist ?? artist ?? null;
}

// A row's key is its section and the key of its occurrence, which keeps an occurrence apart from itself
// in another section.
const rowKey = (section: string, item: PlaybackItem) => `${section}:${item.key}`;
/** The key of the occurrence the row `key` shows. */
const occurrenceKey = (key: string) => key.slice(key.indexOf(":") + 1);
const USER_SECTION = "user";
/** What the queue is called in `SongDrag.rows`. */
const QUEUE_LIST = "queue";

/** The queue keys of the selected rows that the user queued, which are the ones that can be removed. */
const queuedKeys = (selection: TrackSelection) => selection.items.flatMap(({ key }) => (key.startsWith(`${USER_SECTION}:`) ? [occurrenceKey(key)] : []));

/**
 * Puts dragged songs into the user queue before its occurrence `beforeKey`, or after the last. Occurrences
 * dragged from the user queue itself move there; anything else is queued, again if it is queued already.
 */
function dropInQueue(drag: SongDrag, beforeKey: string | null) {
  const placed = drag.rows?.list === QUEUE_LIST ? QueueActions.moveQueued(drag.rows.keys, beforeKey) : drag.songIds().then((songIds) => QueueActions.enqueue(songIds, beforeKey));
  void placed.catch(failureNotice("The songs could not be added to the queue."));
}

/** What is playing and what follows it, in playback order: the user queue plays before the source resumes. */
function useQueueItems(): {
  items: TrackListItem[];
  playingKey: string | null;
  /** Where the user queue's rows start and end among the items, which is where songs dropped on the queue go. Both are where they would be when it is empty. */
  queued: { start: number; end: number };
} {
  const queue = useQueueManagerState();
  const sourceName = useSourceName(queue.source?.ref ?? null);

  return useMemo(() => {
    const items: TrackListItem[] = [];
    const section = (id: string, title: string, entries: readonly PlaybackItem[]) => {
      if (entries.length === 0) return;
      items.push({ type: "heading", key: id, title });
      for (const entry of entries) items.push({ type: "track", key: rowKey(id, entry), song: entry.track });
    };

    section("now", "Now playing", queue.nowPlaying ? [queue.nowPlaying] : []);
    const start = queue.userQueue.length === 0 ? items.length : items.length + 1;
    section(USER_SECTION, "Next in queue", queue.userQueue);
    const queued = { start, end: items.length };
    section("source", sourceName ? `Next from ${sourceName}` : "Next up", queue.source?.window.next ?? []);
    // Main keeps only a window of the source loaded and moves it along with playback.
    if (queue.source?.window.hasMore) items.push({ type: "note", key: "source-more", label: "More tracks load as playback continues." });

    return { items, playingKey: queue.nowPlaying ? rowKey("now", queue.nowPlaying) : null, queued };
  }, [queue, sourceName]);
}

/** Shows or hides the queue panel. */
export function QueuePanelToggle() {
  const open = useStore(panelOpen);
  // With the panel closed, songs dropped on its button go to the end of the queue.
  const drop = useSongDrop((drag) => dropInQueue(drag, null), { disabled: open });

  return (
    <Button
      size="icon-sm"
      variant="ghost"
      onClick={togglePanel}
      aria-label={open ? "Hide queue" : "Show queue"}
      aria-expanded={open}
      title="Queue"
      className={cn(drop.over && "bg-muted ring-2 ring-brand ring-inset")}
      {...drop.props}
    >
      <QueueIcon weight={open ? "fill" : "regular"} className="size-4" />
    </Button>
  );
}

/** The playback queue as a column on the right of the window. */
export function QueuePanel() {
  const open = useStore(panelOpen);
  return open ? <QueuePanelContent /> : null;
}

function QueuePanelContent() {
  const { items, playingKey, queued } = useQueueItems();
  const emptyDrop = useSongDrop((drag) => dropInQueue(drag, null));

  return (
    <aside aria-label="Queue" className="scrollbar-area relative h-(--main-height) w-72 shrink-0 animate-in border-l bg-sidebar text-sidebar-foreground duration-200 fade-in-0 slide-in-from-right-4">
      {/* Kept clear for the window controls, which sit over this corner on Windows. The list scrolls away under it. */}
      <div className="app-drag-region absolute top-0 z-10 h-(--top-height) w-full bg-sidebar [-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_100%)]" />

      {items.length === 0 ? (
        <div {...emptyDrop.props} className={cn("h-full px-4 pt-(--top-height) text-xs text-sidebar-foreground/60", emptyDrop.over && "bg-muted/50 ring-2 ring-brand ring-inset")}>
          {emptyDrop.over ? "Drop to add to the queue." : "Nothing is playing."}
        </div>
      ) : (
        <TrackList
          items={items}
          columns={compactColumns}
          playingKey={playingKey}
          onActivate={(item) => void QueueActions.select(occurrenceKey(item.key)).catch(failureNotice("The track could not be played."))}
          // Rows the user queued move when they are dragged within the queue, as long as nothing else is dragged with them.
          dragOf={(selection) => {
            const keys = queuedKeys(selection);
            return { ...songDragOf(selection), ...(keys.length === selection.items.length ? { rows: { list: QUEUE_LIST, keys } } : {}) };
          }}
          drop={{
            list: QUEUE_LIST,
            gapAt: (index, after) => Math.min(Math.max(after ? index + 1 : index, queued.start), queued.end),
            onDrop: (drag, gap) => dropInQueue(drag, gap < queued.end ? occurrenceKey(items[gap]!.key) : null),
          }}
          className="scrollbar-slim"
          topPadding={TOP_HEIGHT}
          bottomPadding={8}
          menu={(selection) => {
            const queued = queuedKeys(selection);

            return (
              <>
                <TrackMenuAddItems selection={selection} />
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={queued.length === 0}
                  onClick={() => void QueueActions.removeQueued(queued).catch(failureNotice(`The ${queued.length === 1 ? "track" : "tracks"} could not be removed from the queue.`))}
                >
                  Remove from queue
                </ContextMenuItem>
              </>
            );
          }}
        />
      )}
    </aside>
  );
}
