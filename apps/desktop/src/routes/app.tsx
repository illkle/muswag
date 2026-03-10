import { Alert, AlertTitle, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "#/components/ui/card";
import {
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  Sidebar,
} from "#/components/ui/sidebar";
import { userStateQueryOptions } from "#/lib/app-state";
import { SM } from "#/lib/db";
import { getErrorMessage } from "#/lib/err";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { LibraryBig, RefreshCcw, LogOut } from "lucide-react";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
});

const AppSidebarWrapper = ({
  children,
  url,
  username,
}: {
  children: React.ReactNode;
  url: string;
  username: string;
}) => {
  const syncMutation = useMutation({
    mutationFn: () => SM.sync(),
  });
  const logoutMutation = useMutation({
    mutationFn: () => SM.logout(),
  });

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex size-9 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground">
                <LibraryBig className="size-4" />
              </div>
              <div>
                <p className="text-sm font-semibold">Muswag</p>
                <p className="text-xs text-sidebar-foreground/70">Local library workspace</p>
              </div>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <Card
            size="sm"
            className="border border-sidebar-border/70 bg-sidebar-accent/45 shadow-none"
          >
            <CardHeader>
              <CardTitle className="text-sm">Connection</CardTitle>
              <CardDescription>Stored credentials are active for sync.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{username}</p>
                <p className="truncate">{url}</p>
              </div>
              <Badge variant="secondary" className="w-fit">
                Logged in
              </Badge>
            </CardContent>
          </Card>

          <Card size="sm" className="border border-sidebar-border/70 bg-sidebar shadow-none">
            <CardHeader>
              <CardTitle className="text-sm">Sync</CardTitle>
              <CardDescription>Pull the latest albums from the server.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                className="w-full justify-center"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
              >
                <RefreshCcw className={syncMutation.isPending ? "animate-spin" : ""} />
                {syncMutation.isPending ? "Syncing..." : "Sync now"}
              </Button>

              {syncMutation.data ? (
                <div className="rounded-lg border border-border/70 bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  {syncMutation.data.fetched} fetched, {syncMutation.data.inserted} new,{" "}
                  {syncMutation.data.updated} updated
                </div>
              ) : null}

              {syncMutation.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>Sync failed</AlertTitle>
                  <AlertDescription>
                    {getErrorMessage(syncMutation.error, "The library could not be synced.")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        </SidebarContent>

        <SidebarFooter>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
          >
            <LogOut />
            {logoutMutation.isPending ? "Logging out..." : "Logout"}
          </Button>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
};

function RouteComponent() {
  const userStateQuery = useQuery(userStateQueryOptions);

  if (!userStateQuery.data) {
    return <Navigate to="/" />;
  }

  return (
    <AppSidebarWrapper url={userStateQuery.data.url} username={userStateQuery.data.username}>
      <Outlet />
    </AppSidebarWrapper>
  );
}
