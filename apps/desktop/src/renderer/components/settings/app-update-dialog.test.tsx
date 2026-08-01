// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateState } from "#shared/ipc";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getState: vi.fn(),
  install: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock("#/lib/ipc", () => ({
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
    mocks.check.mockReset().mockResolvedValue(upToDate);
    mocks.install.mockReset().mockResolvedValue(undefined);
  });

  it("shows the installed version and forces a check when asked", () => {
    render(<AppUpdateDialog onOpenChange={() => undefined} open state={upToDate} />);

    expect(screen.getByText("Muswag v1.2.3")).toBeTruthy();
    expect(screen.getByText("You’re on the latest version")).toBeTruthy();
    expect(screen.getByText("Latest")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Check for updates/ }));

    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it("offers a restart once an update has been downloaded", () => {
    render(
      <AppUpdateDialog
        onOpenChange={() => undefined}
        open
        state={{ ...upToDate, latestVersion: "1.3.0", progressPercent: 100, status: "ready" }}
      />,
    );

    expect(screen.getByText("Update downloaded, restart to install")).toBeTruthy();
    expect(screen.getByText("v1.3.0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Restart and install/ }));

    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it("disables the check in unpackaged builds", () => {
    render(
      <AppUpdateDialog
        onOpenChange={() => undefined}
        open
        state={{ ...upToDate, canCheck: false, latestVersion: null, lastCheckedAt: null, status: "disabled" }}
      />,
    );

    expect(screen.getByText("Updates are only checked in packaged builds")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check for updates/ }).hasAttribute("disabled")).toBe(true);
  });
});
