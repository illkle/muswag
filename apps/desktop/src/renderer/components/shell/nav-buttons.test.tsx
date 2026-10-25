// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { memo } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { NavButtons } from "#/components/shell/nav-buttons";

// The router resets the scroll on each navigation, which jsdom reports it cannot do.
beforeAll(() => {
  window.scrollTo = () => {};
});
afterEach(cleanup);

// Memoized, as the React Compiler leaves the sidebar's element, so only the buttons' own subscriptions re-render them.
const Shell = memo(function Shell() {
  return (
    <>
      <NavButtons />
      <Outlet />
    </>
  );
});

function renderAt(...paths: string[]) {
  const rootRoute = createRootRoute({ component: Shell });
  const page = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => <div>{path}</div> });
  const router = createRouter({
    routeTree: rootRoute.addChildren(paths.map(page)),
    history: createMemoryHistory({ initialEntries: [paths[0]!] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("NavButtons", () => {
  it("can go forward again after going back, past the first page", async () => {
    const router = renderAt("/albums", "/album", "/artist");
    await screen.findByText("/albums");

    act(() => router.history.push("/album"));
    await screen.findByText("/album");
    act(() => router.history.push("/artist"));
    await screen.findByText("/artist");
    expect(button("Go back").disabled).toBe(false);
    expect(button("Go forward").disabled).toBe(true);

    act(() => router.history.back());
    await screen.findByText("/album");
    expect(button("Go back").disabled).toBe(false);
    expect(button("Go forward").disabled).toBe(false);
  });

  it("cannot go forward once a page is opened from a page gone back to", async () => {
    const router = renderAt("/albums", "/album", "/artist");
    await screen.findByText("/albums");

    act(() => router.history.push("/album"));
    await screen.findByText("/album");
    act(() => router.history.back());
    await screen.findByText("/albums");
    expect(button("Go forward").disabled).toBe(false);

    act(() => router.history.push("/artist"));
    await screen.findByText("/artist");
    expect(button("Go forward").disabled).toBe(true);
  });
});
