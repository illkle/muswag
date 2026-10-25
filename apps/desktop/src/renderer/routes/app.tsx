import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { TopBar } from "#/components/shell/top-bar";
import { AppSidebarWrapper } from "#/components/shell/app-sidebar";
import { PlayerPanel } from "#/components/player-panel";
import { Notices } from "#/components/notices";
import { useSkippedTrackNotices } from "#/queue/unplayable";
import { NewPlaylistDialog } from "#/components/playlist/new-playlist-dialog";
import { MpvInfoDialog } from "#/components/settings/mpv-info-dialog";
import { useSetupDone } from "#/onboarding/setup-state";
import { useUser } from "#/session/session";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
});

function RouteComponent() {
  const userStateQuery = useUser();
  const setupDone = useSetupDone();
  useSkippedTrackNotices();

  if (userStateQuery.isLoading) {
    return null;
  }

  // Setup is not finished: its page is at the start.
  if (!userStateQuery.data || !setupDone) {
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
      <AppSidebarWrapper>
        <TopBar />
        <Outlet />
        <PlayerPanel />
        <Notices />
      </AppSidebarWrapper>
      <NewPlaylistDialog />
      <MpvInfoDialog />
    </div>
  );
}
