import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/songs")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
