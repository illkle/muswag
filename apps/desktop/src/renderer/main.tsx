import { createHashHistory, createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import ReactDOM from "react-dom/client";
import { StrictMode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import "./styles.css";
import { ThemeProvider } from "#/components/utils/theme-provider";
import { AppClient } from "#/core/client";
if (import.meta.env.DEV) {
  void import("react-scan").then(({ scan }) => scan({ enabled: true }));
}

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
  void AppClient.start().then(() => {
    root.render(
      <StrictMode>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </StrictMode>,
    );
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
