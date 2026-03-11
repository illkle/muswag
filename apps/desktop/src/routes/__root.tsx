import { createRootRoute, Outlet } from "@tanstack/react-router";

import { useAppEvents } from "#/components/app-state-provider";

const RootLayout = () => {
  useAppEvents();

  return (
    <>
      <Outlet />
    </>
  );
};

export const Route = createRootRoute({ component: RootLayout });
