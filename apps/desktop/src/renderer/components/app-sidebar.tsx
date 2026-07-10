import { AppContentSizeProvider } from "#/components/app-content-size";
import { MpvInfoDialog } from "#/components/mpv-info-dialog";
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
import { DiscAlbum, LogsIcon } from "lucide-react";

import React from "react";

export function AppSidebar() {
  const r = useMatchRoute();

  const n = useNavigate();

  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
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
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
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

/*

 <Button
          render={() => (
            <Link
              to="/app/albums"
              className="transition-colors px-2"
              activeProps={{ className: "bg-muted-foreground text-secondary" }}
              preload="intent"
            >
              Albums
            </Link>
          )}
        ></Button>

        <Link
          to="/app/songs"
          className="transition-colors px-2"
          activeProps={{ className: "bg-muted-foreground text-secondary" }}
          preload="intent"
        >
          <Button>Songs</Button>
        </Link>

        */
