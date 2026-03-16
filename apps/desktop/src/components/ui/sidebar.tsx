import * as React from "react";

import { cn } from "#/lib/utils";

function SidebarProvider({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-provider"
      className={cn("min-h-(--main-height) bg-background grid grid-cols-[15rem_1fr]", className)}
      {...props}
    />
  );
}

function Sidebar({ className, ...props }: React.ComponentProps<"aside">) {
  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:min-h-(--main-height) md:border-r md:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("border-b border-sidebar-border px-5 py-5", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex flex-col gap-4 px-4 py-4", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("mt-auto border-t border-sidebar-border px-4 py-4", className)}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "min-w-0 bg-[radial-gradient(circle_at_top,_color-mix(in_oklab,var(--color-primary)_8%,transparent),transparent_40%),linear-gradient(180deg,color-mix(in_oklab,var(--color-muted)_50%,transparent),transparent_30%)]",
        className,
      )}
      {...props}
    />
  );
}

export { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarProvider };
