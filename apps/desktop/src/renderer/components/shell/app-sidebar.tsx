import { AppContentSizeProvider } from "#/components/utils/app-content-size";
import { ServerMenu } from "#/components/settings/server-menu";

import { SidebarProvider, SidebarContent, SidebarInset, Sidebar, SidebarGroup, SidebarFooter, SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "#/components/ui/sidebar";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { MusicNotesIcon, VinylRecordIcon } from "@phosphor-icons/react";

import React from "react";
import { NavButtons } from "#/components/shell/nav-buttons";
import { SidebarPlaylists } from "#/components/shell/sidebar-playlists";
import { QueuePanel } from "#/components/queue-panel";

export function AppSidebar() {
  const r = useMatchRoute();

  const n = useNavigate();

  const albumsActive = Boolean(r({ to: "/app/albums" }));
  const songsActive = Boolean(r({ to: "/app/songs" }));

  return (
    // Never collapsed: it is the only way around the app, so it keeps its place however narrow the window is.
    <Sidebar collapsible="none" className="scrollbar-area h-(--main-height) shrink-0 border-r">
      <SidebarContent>
        <SidebarGroup className="shrink-0">
          <div className="flex h-(--top-height) w-full gap-4">
            <div className="app-drag-region w-full"></div>
            <NavButtons />
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={albumsActive} onClick={() => n({ to: "/app/albums" })}>
                <VinylRecordIcon weight={albumsActive ? "fill" : "regular"} /> Albums
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={songsActive} onClick={() => n({ to: "/app/songs" })}>
                <MusicNotesIcon weight={songsActive ? "fill" : "regular"} /> Songs
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarPlaylists />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ServerMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export const AppSidebarWrapper = ({ children }: { children: React.ReactNode }) => {
  return (
    <SidebarProvider open={true} className="relative">
      <AppSidebar />

      <SidebarInset className="scrollbar-area grid h-(--main-height) min-w-0 grid-rows-[minmax(0,1fr)_auto]">
        <AppContentSizeProvider>{children}</AppContentSizeProvider>
      </SidebarInset>

      {/*
        The queue has a column of its own while the window is wide enough to leave the page a usable one.
        In a narrower window it lies over the right of the page instead, between the top bar and the player,
        so the search and the player's controls stay in reach.
      */}
      <div className="shrink-0 empty:hidden max-lg:absolute max-lg:top-(--top-height) max-lg:right-0 max-lg:z-10 max-lg:border-y max-lg:shadow-xl max-lg:[--main-height:calc(100vh-var(--top-height)-var(--player-height))]">
        <QueuePanel />
      </div>
    </SidebarProvider>
  );
};
