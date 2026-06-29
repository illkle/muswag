import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/albums")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
