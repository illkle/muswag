import { AddToPlaylistMenu } from "#/components/playlist/add-to-playlist-menu";
import type { TrackSelection } from "#/components/track-list/types";
import { ContextMenuGroup, ContextMenuItem } from "#/components/ui/context-menu";
import { failureNotice } from "#/lib/notify";
import { QueueActions } from "#/queue/queue";

/** The menu items every track list has: adding the selected songs to a playlist or to the queue. */
export function TrackMenuAddItems({ selection }: { selection: TrackSelection }) {
  const { songs } = selection;

  return (
    <ContextMenuGroup>
      <AddToPlaylistMenu songIds={songs.map(({ id }) => id)} />
      <ContextMenuItem
        disabled={songs.length === 0}
        onClick={() => void QueueActions.enqueue(songs).catch(failureNotice(`The ${songs.length === 1 ? "song" : "songs"} could not be added to the queue.`))}
      >
        Add to queue
      </ContextMenuItem>
    </ContextMenuGroup>
  );
}
