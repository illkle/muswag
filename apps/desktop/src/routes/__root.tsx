import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { useAppEvents } from "#/components/app-state-provider";
import { PlayerProvider } from "#/components/player-provider";

const RootLayout = () => {
  useAppEvents();

  return (
    <>
      <PlayerProvider>
        <Outlet />
        <TanStackRouterDevtools position="top-right" />
      </PlayerProvider>
    </>
  );
};

export const Route = createRootRoute({ component: RootLayout });
