import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { cn } from "#/lib/utils";

/**
 * An error as one red line under what failed, with a small filled warning icon: never a box. `alert` announces
 * it as it appears, for an action that just failed rather than a state the screen opens on.
 */
export function InlineError({ children, className, id, alert = false }: { children: ReactNode; className?: string; id?: string; alert?: boolean }) {
  return (
    <p id={id} role={alert ? "alert" : undefined} className={cn("flex gap-1.5 text-xs text-destructive", className)}>
      <WarningCircleIcon className="mt-px size-3.5 shrink-0" weight="fill" />
      <span className="[overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}
