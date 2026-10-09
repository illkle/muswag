import { cn } from "#/lib/utils";
import type { ReactNode } from "react";

/** What a page shows in place of its content: that it is loading, empty, missing or could not be read. */
export function PageState({
  icon,
  title,
  description,
  tone = "default",
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  /** `quiet` is for a state that passes on its own, such as loading. */
  tone?: "default" | "quiet" | "error";
}) {
  return (
    <section role={tone === "error" ? "alert" : undefined} className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 pt-(--top-height) pb-(--player-height) text-center">
      {icon ? (
        <div className={cn("flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-6", tone === "error" && "bg-destructive/10 text-destructive")}>{icon}</div>
      ) : null}
      <div className="max-w-sm space-y-1 text-sm">
        <p className={tone === "quiet" ? "text-muted-foreground" : "font-medium"}>{title}</p>
        {description ? <p className="text-muted-foreground">{description}</p> : null}
      </div>
    </section>
  );
}
