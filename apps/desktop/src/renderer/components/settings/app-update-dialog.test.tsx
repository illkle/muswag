// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateState } from "#shared/state/app-update";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  setChannel: vi.fn(),
}));

// The update state is what main publishes, and a test has no main.
vi.mock("#/data/app-state", () => ({ appState: {} }));

vi.mock("#/updates/app-update", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/updates/app-update")>()),
  AppUpdateIPC: mocks,
}));

vi.mock("#/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { AppUpdateDialog } from "./app-update-dialog";

const upToDate: AppUpdateState = {
  canCheck: true,
  channel: "stable",
  currentVersion: "1.2.3",
  error: null,
  latestVersion: "1.2.3",
  lastCheckedAt: "2026-07-16T12:00:00.000Z",
  progressPercent: null,
  status: "up-to-date",
};

describe("AppUpdateDialog", () => {
  // Vitest globals are disabled in this project, so React Testing Library cannot auto-clean.
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.check.mockReset().mockResolvedValue(undefined);
    mocks.install.mockReset().mockResolvedValue(undefined);
    mocks.setChannel.mockReset().mockResolvedValue(undefined);
  });

  it("shows the installed version and forces a check when asked", () => {
    render(<AppUpdateDialog onOpenChange={() => undefined} open state={upToDate} />);

    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText(/^Up to date, checked /)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it("offers a restart once an update has been downloaded", () => {
    render(<AppUpdateDialog onOpenChange={() => undefined} open state={{ ...upToDate, latestVersion: "1.3.0", progressPercent: 100, status: "ready" }} />);

    expect(screen.getByText("Ready to install v1.3.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Restart and install" }));

    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it("offers no check in unpackaged builds, and says the channel waits for a packaged one", () => {
    render(<AppUpdateDialog onOpenChange={() => undefined} open state={{ ...upToDate, canCheck: false, latestVersion: null, lastCheckedAt: null, status: "disabled" }} />);

    expect(screen.getByText("Updates are off in development builds")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.getByText("Takes effect in packaged builds")).toBeTruthy();
  });

  it("says a check or download failed, keeps what the updater said behind details, and offers to try again", () => {
    render(<AppUpdateDialog onOpenChange={() => undefined} open state={{ ...upToDate, error: "net::ERR_INTERNET_DISCONNECTED", status: "error" }} />);

    expect(screen.getByText("Update failed")).toBeTruthy();
    expect(screen.getByText("net::ERR_INTERNET_DISCONNECTED")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it("switches the update channel", () => {
    render(<AppUpdateDialog onOpenChange={() => undefined} open state={upToDate} />);

    expect(screen.getByRole("radio", { name: "Stable" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Stable releases only")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Nightly" }));

    expect(mocks.setChannel).toHaveBeenCalledWith("nightly");
  });

  it("says a nightly install on the stable channel waits for a newer stable release", () => {
    render(<AppUpdateDialog onOpenChange={() => undefined} open state={{ ...upToDate, currentVersion: "1.2.4-nightly.20261025.7" }} />);

    expect(screen.getByText("This nightly stays until a stable release is newer")).toBeTruthy();
  });
});
