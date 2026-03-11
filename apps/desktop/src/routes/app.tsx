import { userStateQueryOptions } from "#/lib/app-state";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { TopBar } from "#/components/top-bar";
import { AppSidebarWrapper } from "#/components/app-sidebar";
import { PlayerPanel } from "#/components/player-panel";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
});

function RouteComponent() {
  const userStateQuery = useQuery(userStateQueryOptions);

  if (userStateQuery.isLoading) {
    return null;
  }

  if (!userStateQuery.data) {
    return <Navigate to="/" replace />;
  }

  if (userStateQuery.data.status === "logged_out") {
    return <Navigate to="/" replace />;
  }

  return (
    <div>
      <TopBar />
      <AppSidebarWrapper>
        <Outlet />
      </AppSidebarWrapper>

      <PlayerPanel />
    </div>
  );
}
