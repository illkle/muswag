import { AddToPlaylistMenu } from "#/components/playlist/add-to-playlist-menu";
import type { TrackSelection } from "#/components/track-list/types";
import { ContextMenuGroup, ContextMenuItem } from "#/components/ui/context-menu";
import { failureNotice } from "#/lib/notify";
import { QueueActions } from "#/queue/queue";

/** The menu items every track list has: adding the selected songs to a playlist or to the queue. */
export function TrackMenuAddItems({ selection }: { selection: TrackSelection }) {
  const { count, songIds } = selection;

  return (
    <ContextMenuGroup>
      <AddToPlaylistMenu count={count} songIds={songIds} />
      <ContextMenuItem
        disabled={count === 0}
        onClick={() =>
          void songIds()
            .then(QueueActions.enqueue)
            .catch(failureNotice(`The ${count === 1 ? "song" : "songs"} could not be added to the queue.`))
        }
      >
        Add to queue
      </ContextMenuItem>
    </ContextMenuGroup>
  );
}
