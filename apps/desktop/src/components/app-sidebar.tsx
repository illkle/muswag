import { AppContentSizeProvider } from "#/components/app-content-size";
import { SidebarProvider, SidebarContent, SidebarInset, Sidebar } from "#/components/ui/sidebar";
import { Link } from "@tanstack/react-router";

export const AppSidebarWrapper = ({ children }: { children: React.ReactNode }) => {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <Link
            to="/app/albums"
            className="transition-colors px-2"
            activeProps={{ className: "bg-muted-foreground text-secondary" }}
            preload="intent"
          >
            Albums
          </Link>
          <Link
            to="/app/songs"
            className="transition-colors px-2"
            activeProps={{ className: "bg-muted-foreground text-secondary" }}
            preload="intent"
          >
            Songs
          </Link>
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="grid h-(--main-height) grid-rows-[minmax(0,1fr)_auto]">
        <AppContentSizeProvider>{children}</AppContentSizeProvider>
      </SidebarInset>
    </SidebarProvider>
  );
};
