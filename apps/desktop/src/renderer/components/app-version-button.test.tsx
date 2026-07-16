// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateState } from "#shared/ipc";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getState: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock("#/lib/ipc", () => ({
  AppUpdateIPC: mocks,
}));

vi.mock("#/components/ui/sidebar", () => ({
  SidebarMenuButton: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => <button {...props} />,
}));

vi.mock("#/components/ui/tooltip", () => ({
  Tooltip: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  TooltipContent: ({ align: _align, side: _side, sideOffset: _sideOffset, ...props }: ComponentProps<"div"> & Record<string, unknown>) => (
    <div {...props} />
  ),
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
}));

import { AppVersionButton } from "./app-version-button";

const updateState: AppUpdateState = {
  canCheck: true,
  currentVersion: "1.2.3",
  error: null,
  latestVersion: "1.2.3",
  lastCheckedAt: "2026-07-16T12:00:00.000Z",
  progressPercent: null,
  status: "up-to-date",
};

describe("AppVersionButton", () => {
  beforeEach(() => {
    mocks.check.mockReset().mockResolvedValue(updateState);
    mocks.getState.mockReset().mockResolvedValue(updateState);
    mocks.subscribe.mockClear();
  });

  it("shows version details and forces an update check when clicked", async () => {
    render(<AppVersionButton />);

    const button = await screen.findByRole("button", { name: "Muswag version 1.2.3. Check for updates" });
    expect(screen.getByText("You’re up to date")).toBeTruthy();
    expect(screen.getByText("Latest")).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() => expect(mocks.check).toHaveBeenCalledOnce());
  });
});
