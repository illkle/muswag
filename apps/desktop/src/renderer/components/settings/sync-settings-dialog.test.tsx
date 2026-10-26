// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibrarySyncStatus } from "@muswag/model";

const mocks = vi.hoisted(() => ({
  librarySync: { running: false, progress: null, error: null, lastSyncedAt: null } as LibrarySyncStatus,
  sync: vi.fn<() => Promise<void>>(),
  lastScan: vi.fn<() => Promise<string | null>>(),
  setSyncSettings: vi.fn<(settings: unknown) => Promise<void>>(),
}));

vi.mock("#/library/actions", () => ({
  LibraryActions: { sync: mocks.sync, lastScan: mocks.lastScan, setSyncSettings: mocks.setSyncSettings },
}));

vi.mock("#/library/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/library/queries")>()),
  useLibrarySyncStatus: () => mocks.librarySync,
  useSyncSettings: () => ({ syncAfter: { amount: 1, unit: "weeks" } }),
}));

// The state is what main publishes, and a test has no main.
vi.mock("#/data/app-state", () => ({ appState: {} }));

const { SyncSettingsDialog } = await import("./sync-settings-dialog");

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SyncSettingsDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("SyncSettingsDialog", () => {
  beforeEach(() => {
    mocks.librarySync = { running: false, progress: null, error: null, lastSyncedAt: null };
    mocks.sync.mockReset().mockResolvedValue(undefined);
    mocks.lastScan.mockReset().mockResolvedValue(null);
    mocks.setSyncSettings.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows how long after the last sync the app syncs, and saves a whole number of any unit", async () => {
    renderDialog();
    const field = screen.getByLabelText("Auto sync after") as HTMLInputElement;
    const unit = screen.getByLabelText("Unit") as HTMLSelectElement;
    expect([field.value, unit.value]).toEqual(["1", "weeks"]);
    expect(screen.getByRole("option", { name: "week" })).toBeTruthy();

    fireEvent.change(field, { target: { value: "36" } });
    await waitFor(() => expect(mocks.setSyncSettings).toHaveBeenLastCalledWith({ syncAfter: { amount: 36, unit: "weeks" } }));
    expect(screen.getByRole("option", { name: "weeks" })).toBeTruthy();

    fireEvent.change(field, { target: { value: "2" } });
    await waitFor(() => expect(mocks.setSyncSettings).toHaveBeenLastCalledWith({ syncAfter: { amount: 2, unit: "weeks" } }));
  });

  it("saves a value changed back to the saved one before the change away from it is saved", async () => {
    // Main has not saved the first change yet, so the settings it publishes are still a week.
    mocks.setSyncSettings.mockReturnValue(new Promise(() => {}));
    renderDialog();
    const field = screen.getByLabelText("Auto sync after");

    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.change(field, { target: { value: "1" } });
    expect(mocks.setSyncSettings.mock.calls).toEqual([[{ syncAfter: { amount: 2, unit: "weeks" } }], [{ syncAfter: { amount: 1, unit: "weeks" } }]]);
  });

  it("converts the amount to the unit chosen, to the nearest whole one", async () => {
    renderDialog();
    const field = screen.getByLabelText("Auto sync after") as HTMLInputElement;
    const unit = screen.getByLabelText("Unit");

    fireEvent.change(unit, { target: { value: "days" } });
    expect(field.value).toBe("7");
    await waitFor(() => expect(mocks.setSyncSettings).toHaveBeenLastCalledWith({ syncAfter: { amount: 7, unit: "days" } }));

    fireEvent.change(unit, { target: { value: "hours" } });
    expect(field.value).toBe("168");

    fireEvent.change(field, { target: { value: "36" } });
    fireEvent.change(unit, { target: { value: "days" } });
    expect(field.value).toBe("2");

    // An amount that is not a number stays, for the user to correct.
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.change(unit, { target: { value: "weeks" } });
    expect(field.value).toBe("");
  });

  it("does not save what it does not take, and says why", () => {
    renderDialog();
    const field = screen.getByLabelText("Auto sync after");

    for (const value of ["0", "1.5", "", "60"]) {
      fireEvent.change(field, { target: { value } });
      expect(screen.getByText("Enter a whole number, from 5 minutes to a year.")).toBeTruthy();
    }
    expect(mocks.setSyncSettings).not.toHaveBeenCalled();

    // Too short a time: muswag checks every 5 minutes.
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "minutes" } });
    fireEvent.change(field, { target: { value: "4" } });
    expect(screen.getByText("Enter a whole number, from 5 minutes to a year.")).toBeTruthy();
    expect(mocks.setSyncSettings).not.toHaveBeenCalled();
  });

  it("says when the library last synced, syncs it now, and shows a sync running and why the last one failed", async () => {
    mocks.librarySync = { running: false, progress: null, error: null, lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    renderDialog();
    expect(screen.getByText("5 minutes ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    cleanup();

    mocks.librarySync = { running: true, progress: { done: 30, total: 120 }, error: null, lastSyncedAt: null };
    renderDialog();
    expect(screen.getByText("syncing… 25%")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    mocks.librarySync = { running: false, progress: null, error: "Unable to reach the server", lastSyncedAt: null };
    renderDialog();
    expect(screen.getByText("never")).toBeTruthy();
    expect(screen.getByText("Unable to reach the server")).toBeTruthy();
  });

  it("says whether the server reports lastScan, and what that means for a sync", async () => {
    mocks.lastScan.mockResolvedValue("2026-10-26T12:00:00Z");
    renderDialog();
    expect(await screen.findByText(/which lets muswag download only what changed/)).toBeTruthy();
    cleanup();

    mocks.lastScan.mockResolvedValue(null);
    renderDialog();
    expect(await screen.findByText(/Every sync downloads the full list of songs again/)).toBeTruthy();
    cleanup();

    mocks.lastScan.mockRejectedValue(new Error("Unable to reach the server"));
    renderDialog();
    expect(await screen.findByText("The server could not be asked: Unable to reach the server")).toBeTruthy();
  });
});
