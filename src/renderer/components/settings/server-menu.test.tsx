// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SyncRecord } from "#core";
import type { MpvState } from "#shared/player";

const mocks = vi.hoisted(() => ({
  cancelSync: vi.fn(),
  logout: vi.fn(),
  playerError: null as string | null,
  mpvState: { binaryPath: "/opt/homebrew/bin/mpv", source: "well-known", status: "ready", version: "0.40.0" } as MpvState,
  startSync: vi.fn(),
  syncs: [] as SyncRecord[],
  user: { id: 1, password: "secret", url: "https://music.example.com/", username: "tester" } as { id: number; password: string; url: string; username: string } | undefined,
}));

vi.mock("#/lib/queries", () => ({
  useUser: () => ({ data: mocks.user }),
  useSyncs: () => ({ data: mocks.syncs }),
}));

vi.mock("#/lib/sync-manager", () => ({
  SyncManager: { logout: mocks.logout },
}));

vi.mock("#/components/player-provider", () => ({
  usePlayerError: () => mocks.playerError,
  usePlayerMpvState: () => mocks.mpvState,
}));

vi.mock("#/hooks/use-app-update", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/hooks/use-app-update")>()),
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

vi.mock("#/components/settings/sync-dialog", () => ({ SyncDialog: () => null }));
vi.mock("#/components/settings/mpv-info-dialog", () => ({
  MpvInfoDialog: () => null,
  mpvStatusLabels: { checking: "Checking", invalid: "Not usable", missing: "Not installed", ready: "Available" },
}));
vi.mock("#/components/settings/app-update-dialog", () => ({ AppUpdateDialog: () => null }));

vi.mock("#/hooks/use-sync-controls", () => ({
  useSyncControls: () => ({
    cancelling: false,
    cancelSync: mocks.cancelSync,
    error: null,
    latestSync: mocks.syncs[0] ?? null,
    running: mocks.syncs[0]?.lastStatus === "running",
    startSync: mocks.startSync,
  }),
}));

import { ServerMenu } from "./server-menu";

function renderServerMenu() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ServerMenu />
    </QueryClientProvider>,
  );
}

const runningSync: SyncRecord = {
  id: "sync-1",
  timeStarted: "2026-08-02T12:00:00.000Z",
  timeEnded: null,
  lastStatus: "running",
  error: null,
  mode: "quick",
  currentStep: "fetching-album-details",
  progress: undefined,
};

describe("ServerMenu", () => {
  // Vitest globals are disabled in this project, so React Testing Library cannot auto-clean.
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.cancelSync.mockReset();
    mocks.logout.mockReset().mockResolvedValue(null);
    mocks.startSync.mockReset();
    mocks.playerError = null;
    mocks.mpvState = { binaryPath: "/opt/homebrew/bin/mpv", source: "well-known", status: "ready", version: "0.40.0" };
    mocks.syncs = [];
  });

  it("names the server on the button and gathers the settings behind it", () => {
    renderServerMenu();

    expect(screen.getByRole("button", { name: "music.example.com, server and app settings" })).toBeTruthy();
    expect(screen.getByText("Never synced")).toBeTruthy();
    expect(screen.getByText("Playback engine")).toBeTruthy();
    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("Downloading")).toBeTruthy();
    expect(screen.getByText("theme control")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
  });

  it("marks the button as syncing and draws a progress line", () => {
    mocks.syncs = [runningSync];

    const { container } = renderServerMenu();

    expect(screen.getByRole("button", { name: "music.example.com, server and app settings, syncing" })).toBeTruthy();
    expect(container.querySelector('[data-slot="sync-progress"]')).toBeTruthy();
    expect(screen.getByText("Fetching album details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel sync" })).toBeTruthy();
  });

  it("starts a quick sync from the menu without leaving it", () => {
    renderServerMenu();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect(mocks.startSync).toHaveBeenCalledWith("quick");
  });

  it("raises an alert on the button and the mpv row when playback is unavailable", () => {
    mocks.mpvState = { checkedPaths: [], installOptions: [], status: "missing" };

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
