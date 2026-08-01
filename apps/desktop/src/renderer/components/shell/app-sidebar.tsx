import { AppContentSizeProvider } from "#/components/utils/app-content-size";
import { AppVersionButton } from "#/components/settings/app-version-button";
import { MpvInfoDialog } from "#/components/settings/mpv-info-dialog";
import { ServerInfo } from "#/components/settings/serverInfo";
import { ThemeSwitcher } from "#/components/settings/themeSwitcher";

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
import { DiscAlbum, ListMusic, LogsIcon } from "lucide-react";

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
                <DiscAlbum /> Albums
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={Boolean(r({ to: "/app/songs" }))} onClick={() => n({ to: "/app/songs" })}>
                <LogsIcon /> Songs
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={Boolean(r({ to: "/app/playlists" }))} onClick={() => n({ to: "/app/playlists" })}>
                <ListMusic /> Playlists
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <ServerInfo />
        <AppVersionButton />
        <MpvInfoDialog />
        <ThemeSwitcher className="w-full" />
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
