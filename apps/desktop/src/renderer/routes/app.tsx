import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { TopBar } from "#/components/top-bar";
import { AppSidebarWrapper } from "#/components/app-sidebar";
import { PlayerPanel } from "#/components/player-panel";
import { useUser } from "#/lib/queries";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
});

function RouteComponent() {
  const userStateQuery = useUser();

  if (userStateQuery.isLoading) {
    return null;
  }

  if (!userStateQuery.data) {
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
