// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibrarySyncStatus } from "@muswag/model";

import type { BinaryState } from "#shared/commands/player";

const mocks = vi.hoisted(() => ({
  logout: vi.fn<() => Promise<void>>(),
  playerError: null as string | null,
  librarySync: { running: null, error: null, lastSyncedAt: null } as LibrarySyncStatus,
  binary: { _tag: "Ready", path: "/opt/homebrew/bin/mpv", source: "well-known", version: "0.40.0" } as BinaryState,
  sync: vi.fn<(mode: "full" | "quick") => Promise<void>>(),
  user: { id: 1, password: "secret", url: "https://music.example.com/", username: "tester" } as { id: number; password: string; url: string; username: string } | undefined,
}));

vi.mock("#/session/session", () => ({
  Session: { logout: mocks.logout },
  useUser: () => ({ data: mocks.user }),
}));

vi.mock("#/library/actions", () => ({
  LibraryActions: { sync: mocks.sync },
}));

vi.mock("#/library/queries", () => ({
  useLibrarySyncStatus: () => mocks.librarySync,
}));

vi.mock("#/player/hooks", () => ({
  usePlayerError: () => mocks.playerError,
  usePlayerMpvBinary: () => mocks.binary,
}));

vi.mock("#/updates/app-update", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/updates/app-update")>()),
  useAppUpdate: () => ({
    canCheck: true,
    currentVersion: "1.2.3",
    error: null,
    latestVersion: "1.3.0",
    lastCheckedAt: null,
    progressPercent: 40,
    status: "downloading" as const,
  }),
}));

// Render the menu inline so the popup contents are assertable without opening a portal.
vi.mock("#/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ closeOnClick: _closeOnClick, ...props }: ComponentProps<"button"> & { closeOnClick?: boolean }) => <button {...props} />,
  MenuSeparator: () => <hr />,
  MenuTrigger: ({ render }: { render: ReactNode }) => render,
}));

vi.mock("#/components/ui/sidebar", () => ({
  SidebarMenuButton: (props: ComponentProps<"button">) => <button {...props} />,
}));

vi.mock("#/components/settings/theme-switcher", () => ({
  ThemeMenuControl: () => <div>theme control</div>,
}));

vi.mock("#/components/settings/mpv-info-dialog", () => ({
  MpvInfoDialog: () => null,
  mpvStatusLabels: { Checking: "Checking", Ready: "Available", Unavailable: "Not installed" },
}));
vi.mock("#/components/settings/app-update-dialog", () => ({ AppUpdateDialog: () => null }));

import { ServerMenu } from "./server-menu";

function renderServerMenu() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ServerMenu />
    </QueryClientProvider>,
  );
}

describe("ServerMenu", () => {
  // Vitest globals are disabled in this project, so React Testing Library cannot auto-clean.
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.logout.mockReset().mockResolvedValue(undefined);
    mocks.sync.mockReset().mockResolvedValue(undefined);
    mocks.playerError = null;
    mocks.librarySync = { running: null, error: null, lastSyncedAt: null };
    mocks.binary = { _tag: "Ready", path: "/opt/homebrew/bin/mpv", source: "well-known", version: "0.40.0" };
  });

  it("names the server on the button and gathers the settings behind it", () => {
    renderServerMenu();

    expect(screen.getByRole("button", { name: "music.example.com, server and app settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync library" })).toBeTruthy();
    expect(screen.getByText("Playback engine")).toBeTruthy();
    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("Downloading")).toBeTruthy();
    expect(screen.getByText("theme control")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
  });

  it("starts a quick sync from the menu", async () => {
    renderServerMenu();

    fireEvent.click(screen.getByRole("button", { name: "Sync library" }));

    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith("quick"));
  });

  it("shows a sync running in main that this menu did not start, and does not start another", () => {
    mocks.librarySync = { running: "full", error: null, lastSyncedAt: null };

    renderServerMenu();

    expect(screen.getByRole("button", { name: "music.example.com, server and app settings, syncing" })).toBeTruthy();
    const syncItem = screen.getByRole("button", { name: "Syncing library…" }) as HTMLButtonElement;
    expect(syncItem.disabled).toBe(true);
    fireEvent.click(syncItem);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("raises an alert on the button and the mpv row when playback is unavailable", () => {
    mocks.binary = {
      _tag: "Unavailable",
      reason: "missing",
      issue: { actions: [], code: "BinaryUnavailable", id: "binary", message: "Install mpv or select its executable.", occurrenceKey: null, operation: "discovery" },
      options: [],
    };

    renderServerMenu();

    const trigger = screen.getByRole("button", { name: "music.example.com, server and app settings, playback engine unavailable" });
    expect(trigger.className).toContain("bg-destructive/10");

    const mpvRow = screen.getByText("Playback engine").closest("button");
    expect(mpvRow?.className).toContain("bg-destructive/10");
    expect(screen.getByText("Not installed")).toBeTruthy();
  });

  it("logs out", async () => {
    renderServerMenu();

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(mocks.logout).toHaveBeenCalledOnce());
  });
});
