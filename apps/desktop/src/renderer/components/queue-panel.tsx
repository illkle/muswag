import { QueueIcon } from "@phosphor-icons/react";
import type { PlaybackItem, QueueSourceRef } from "@muswag/model";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { createStore, useStore } from "@tanstack/react-store";
import { useMemo } from "react";

import { compactColumns } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import type { TrackListItem, TrackSelection } from "#/components/track-list/types";
import { Button } from "#/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "#/components/ui/context-menu";
import { db } from "#/data/library";
import { QueueActions, useQueueManagerState } from "#/queue/queue";
import { TOP_HEIGHT } from "#/styles";

const STORAGE_KEY = "muswag-queue-panel-open";

/** Whether the panel is showing. A preference of this window rather than app state, so it stays in the renderer. */
const panelOpen = createStore(localStorage.getItem(STORAGE_KEY) === "true");

function togglePanel() {
  panelOpen.setState((open) => !open);
  localStorage.setItem(STORAGE_KEY, String(panelOpen.state));
}

/** What to call the album, playlist or library the queue is playing through. */
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

  if (ref?.type === "library") return "your library";
  return album?.name ?? playlist?.local?.name ?? null;
}

// A row's key is its section and the key of its occurrence, which keeps an occurrence apart from itself
// in another section.
const rowKey = (section: string, item: PlaybackItem) => `${section}:${item.key}`;
const USER_SECTION = "user";

/** The queue keys of the selected rows that the user queued, which are the ones that can be removed. */
const queuedKeys = (selection: TrackSelection) => selection.items.flatMap(({ key }) => (key.startsWith(`${USER_SECTION}:`) ? [key.slice(USER_SECTION.length + 1)] : []));

async function removeQueued(keys: readonly string[]) {
  for (const key of keys) await QueueActions.removeQueued(key);
}

/** What is playing and what follows it, in playback order: the user queue plays before the source resumes. */
function useQueueItems(): { items: TrackListItem[]; playingKey: string | null } {
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
    section(USER_SECTION, "Next in queue", queue.userQueue);
    section("source", sourceName ? `Next from ${sourceName}` : "Next up", queue.source?.window.next ?? []);
    // Main keeps only a window of the source loaded and moves it along with playback.
    if (queue.source?.window.hasMore) items.push({ type: "note", key: "source-more", label: "More tracks load as playback continues." });

    return { items, playingKey: queue.nowPlaying ? rowKey("now", queue.nowPlaying) : null };
  }, [queue, sourceName]);
}

/** Shows or hides the queue panel. */
export function QueuePanelToggle() {
  const open = useStore(panelOpen);

  return (
    <Button size="icon-sm" variant="ghost" onClick={togglePanel} aria-label={open ? "Hide queue" : "Show queue"} aria-expanded={open} title="Queue">
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
  const { items, playingKey } = useQueueItems();

  return (
    <aside aria-label="Queue" className="scrollbar-area relative h-(--main-height) w-72 shrink-0 animate-in border-l bg-sidebar text-sidebar-foreground duration-200 fade-in-0 slide-in-from-right-4">
      {/* Kept clear for the window controls, which sit over this corner on Windows. The list scrolls away under it. */}
      <div className="app-drag-region absolute top-0 z-10 h-(--top-height) w-full bg-sidebar [-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_100%)]" />

      {items.length === 0 ? (
        <p className="px-4 pt-(--top-height) text-xs text-sidebar-foreground/60">Nothing is playing.</p>
      ) : (
        <TrackList
          items={items}
          columns={compactColumns}
          playingKey={playingKey}
          className="scrollbar-slim"
          topPadding={TOP_HEIGHT}
          bottomPadding={8}
          menu={(selection) => {
            const queued = queuedKeys(selection);

            return (
              <>
                <TrackMenuAddItems selection={selection} />
                <ContextMenuSeparator />
                <ContextMenuItem disabled={queued.length === 0} onClick={() => void removeQueued(queued)}>
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
