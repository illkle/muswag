// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BinaryState } from "#shared/commands/player";

const mocks = vi.hoisted(() => ({
  binary: { _tag: "Checking" } as BinaryState,
  user: undefined as { url: string; username: string } | undefined,
}));

vi.mock("#/session/session", () => ({
  Session: { login: vi.fn() },
  useUser: () => ({ data: mocks.user, expired: undefined, isLoading: false }),
}));
vi.mock("#/player/hooks", () => ({
  usePlayerMpvBinary: () => mocks.binary,
}));
vi.mock("#/player/commands", () => ({ MpvIPC: {} }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ options }),
  Navigate: ({ to }: { to: string }) => <div>Navigated to {to}</div>,
}));

const ready: BinaryState = { _tag: "Ready", path: "/usr/bin/mpv", source: "well-known", version: "0.41.0" };
const missing: BinaryState = { _tag: "Unavailable", message: "mpv was not found. Install it, or select its executable.", options: [], searched: [] };

/** The start page, loaded afresh so that it reads whether setup is done from `localStorage` again. */
async function startPage() {
  vi.resetModules();
  const { Route } = await import("#/routes/index");
  const App = (Route as unknown as { options: { component: ComponentType } }).options.component;
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return {
    rerender: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      ),
  };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  localStorage.clear();
  mocks.binary = { _tag: "Checking" };
  mocks.user = undefined;
});

describe("setup", () => {
  it("starts with the server", async () => {
    await startPage();
    expect(screen.getByRole("heading", { name: "Connect your music server" })).toBeTruthy();
  });

  it("takes a server address without its scheme, which main completes", async () => {
    await startPage();
    const address = screen.getByLabelText("Server URL") as HTMLInputElement;
    fireEvent.change(address, { target: { value: "music.example.com/" } });
    expect(address.validity.valid).toBe(true);
  });

  it("asks for mpv after the login, and opens the app only once the user goes on", async () => {
    mocks.user = { url: "https://music.example.com", username: "me" };
    mocks.binary = missing;
    const page = await startPage();

    expect(screen.getByRole("heading", { name: "Set up playback" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();

    // Installed: the page stays, so the user sees that it worked, and Continue takes the place of Skip.
    mocks.binary = ready;
    page.rerender();
    expect(screen.getByText("Found mpv 0.41.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();

    act(() => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
    expect(screen.getByText("Navigated to /app/albums")).toBeTruthy();
    expect(localStorage.getItem("muswag-setup-done")).toBe("true");
  });

  it("lets the user go on without mpv", async () => {
    mocks.user = { url: "https://music.example.com", username: "me" };
    mocks.binary = missing;
    await startPage();

    act(() => fireEvent.click(screen.getByRole("button", { name: "Skip for now" })));
    expect(screen.getByText("Navigated to /app/albums")).toBeTruthy();
  });

  it("skips the step when mpv is found straight away", async () => {
    mocks.user = { url: "https://music.example.com", username: "me" };
    const page = await startPage();
    expect(screen.getByText("Looking for mpv…")).toBeTruthy();

    mocks.binary = ready;
    page.rerender();
    expect(screen.getByText("Navigated to /app/albums")).toBeTruthy();
  });

  it("only asks a returning user to log in", async () => {
    localStorage.setItem("muswag-setup-done", "true");
    await startPage();
    expect(screen.getByRole("heading", { name: "Log in to your server" })).toBeTruthy();

    mocks.user = { url: "https://music.example.com", username: "me" };
    mocks.binary = missing;
    await startPage();
    expect(screen.getByText("Navigated to /app/albums")).toBeTruthy();
  });
});
