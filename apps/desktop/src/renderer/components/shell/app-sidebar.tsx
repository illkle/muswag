import { AppContentSizeProvider } from "#/components/utils/app-content-size";
import { ServerMenu } from "#/components/settings/server-menu";

import {
  SidebarProvider,
  SidebarContent,
  SidebarInset,
  Sidebar,
  SidebarGroup,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "#/components/ui/sidebar";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { MusicNotesIcon, PlaylistIcon, VinylRecordIcon } from "@phosphor-icons/react";

import React from "react";
import { NavButtons } from "#/components/shell/nav-buttons";

export function AppSidebar() {
  const r = useMatchRoute();

  const n = useNavigate();

  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup className="">
          <div className="flex h-(--top-height) w-full gap-4">
            <div className="app-drag-region w-full"></div>
            <NavButtons />
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={Boolean(r({ to: "/app/albums" }))} onClick={() => n({ to: "/app/albums" })}>
                <VinylRecordIcon /> Albums
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={Boolean(r({ to: "/app/songs" }))} onClick={() => n({ to: "/app/songs" })}>
                <MusicNotesIcon /> Songs
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={Boolean(r({ to: "/app/playlists" }))} onClick={() => n({ to: "/app/playlists" })}>
                <PlaylistIcon /> Playlists
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
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
    <SidebarProvider open={true}>
      <AppSidebar />

      <SidebarInset className="grid h-(--main-height) grid-rows-[minmax(0,1fr)_auto]">
        <AppContentSizeProvider>{children}</AppContentSizeProvider>
      </SidebarInset>
    </SidebarProvider>
  );
};
