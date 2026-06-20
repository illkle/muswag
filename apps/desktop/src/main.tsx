import { createHashHistory, createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import ReactDOM from "react-dom/client";
import { StrictMode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import "./styles.css";
import { scan } from "react-scan";
scan({
  enabled: true,
});

const queryClient = new QueryClient();

const router = createTanStackRouter({
  routeTree,
  context: { queryClient },
  defaultNotFoundComponent: () => <div>not found</div>,
  scrollRestoration: true,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  history: createHashHistory(),
});

setupRouterSsrQueryIntegration({
  router,
  queryClient,
});

const rootElement = document.getElementById("root")!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
