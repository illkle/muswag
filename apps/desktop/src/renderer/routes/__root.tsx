import { createRootRoute, Outlet } from "@tanstack/react-router";

import { useRediscoverMpvOnFocus } from "#/player/rediscover";

const RootLayout = () => {
  useRediscoverMpvOnFocus();
  return (
    <>
      <Outlet />
    </>
  );
};

export const Route = createRootRoute({ component: RootLayout });
