import { CaretRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { cn } from "#/lib/utils";

/**
 * Detail most people need not read, folded under a small caret: a native `<details>`, so keys and copying
 * reach it. `label` is what it says while closed, `openLabel` while open.
 */
export function Disclosure({ label, openLabel, children, className }: { label: ReactNode; openLabel: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={cn("group text-xs text-muted-foreground", className)}>
      <summary className="inline-flex cursor-default list-none items-center gap-1.5 rounded-sm outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <CaretRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
        <span className="group-open:hidden">{label}</span>
        <span className="hidden group-open:inline">{openLabel}</span>
      </summary>
      <div className="mt-1 max-h-32 overflow-y-auto pl-5 [overflow-wrap:anywhere] select-text">{children}</div>
    </details>
  );
}
