// Stays first: the modules below read `window.electron` as they load.
import "#/data/dev-bridge";
import { createHashHistory, createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReactDOM from "react-dom/client";
import { StrictMode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import "./styles.css";
import { ThemeProvider } from "#/components/utils/theme-provider";
import { Session } from "#/session/session";
// Opt in with `VITE_REACT_SCAN=1`: its outlines get in the way when looking at the interface itself.
if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN) {
  void import("react-scan").then(({ scan }) => scan({ enabled: true }));
}

const queryClient = new QueryClient();

const router = createTanStackRouter({
  routeTree,
  context: { queryClient },
  defaultNotFoundComponent: () => <div>not found</div>,
  scrollRestoration: true,
  // A page for another album, artist or playlist starts over: its queries, scroll position and dialogs are its own.
  defaultRemountDeps: ({ params }) => params,
  history: createHashHistory(),
});

const root = ReactDOM.createRoot(document.getElementById("root")!);
void Session.start().then(() => {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
