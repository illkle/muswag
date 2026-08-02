import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { TopBar } from "#/components/shell/top-bar";
import { AppSidebarWrapper } from "#/components/shell/app-sidebar";
import { PlayerPanel } from "#/components/player-panel";
import { useUser } from "#/lib/queries";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";
import { IconContext } from "@phosphor-icons/react";

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
    <div
      style={
        {
          "--top-height": TOP_HEIGHT + "px",
          "--player-height": PLAYER_HEIGHT + "px",
          "--main-height": "100vh",
        } as React.CSSProperties
      }
    >
      <IconContext.Provider value={{ weight: "fill" }}>
        <AppSidebarWrapper>
          <TopBar />
          <Outlet />
          <PlayerPanel />
        </AppSidebarWrapper>
      </IconContext.Provider>
    </div>
  );
}
