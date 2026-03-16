import { AppContentSizeProvider } from "#/components/app-content-size";
import { SidebarProvider, SidebarContent, SidebarInset, Sidebar } from "#/components/ui/sidebar";

export const AppSidebarWrapper = ({ children }: { children: React.ReactNode }) => {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent></SidebarContent>
      </Sidebar>

      <SidebarInset className="grid h-(--main-height) grid-rows-[minmax(0,1fr)_auto]">
        <AppContentSizeProvider>{children}</AppContentSizeProvider>
      </SidebarInset>
    </SidebarProvider>
  );
};
