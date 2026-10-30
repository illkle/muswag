import type { QueueSourceRef } from "@muswag/model";
import { ShuffleIcon } from "@phosphor-icons/react";

import { Button } from "#/components/ui/button";
import { failureNotice } from "#/lib/notify";
import { QueueActions } from "#/queue/queue";

/** Plays `source` in a new random order. As tall as the Play button of a page's header, or `small` over a list. */
export function ShuffleButton({ source, disabled, small }: { source: QueueSourceRef; disabled?: boolean; small?: boolean }) {
  return (
    <Button
      variant="secondary"
      size={small ? "sm" : "default"}
      className={small ? "gap-1.5" : "h-10 w-32 gap-2 text-base [&_svg]:size-5"}
      disabled={disabled}
      onClick={() => void QueueActions.shuffleSource(source).catch(failureNotice("The songs could not be shuffled."))}
    >
      <ShuffleIcon />
      Shuffle
    </Button>
  );
}
