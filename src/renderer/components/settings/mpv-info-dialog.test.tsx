// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MpvInstallState, MpvState } from "#shared/player";

const mocks = vi.hoisted(() => ({
  cancelInstall: vi.fn(),
  clearManualPath: vi.fn(),
  install: vi.fn(),
  locate: vi.fn(),
  playerState: {
    error: null as string | null,
    installState: { status: "idle" } as MpvInstallState,
    mpvState: { status: "checking" } as MpvState,
  },
  recheck: vi.fn(),
  subscribeInstallOutput: vi.fn((_listener: (output: { line: string; stream: "stdout" | "stderr" }) => void) => () => undefined),
}));

vi.mock("#/lib/ipc", () => ({
  MpvIPC: {
    cancelInstall: mocks.cancelInstall,
    clearManualPath: mocks.clearManualPath,
    install: mocks.install,
    locate: mocks.locate,
    recheck: mocks.recheck,
    subscribeInstallOutput: mocks.subscribeInstallOutput,
  },
}));

vi.mock("#/components/player-provider", () => ({
  usePlayerError: () => mocks.playerState.error,
  usePlayerMpvInstallState: () => mocks.playerState.installState,
  usePlayerMpvState: () => mocks.playerState.mpvState,
  usePlayerStatus: () => "idle",
}));

vi.mock("#/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { MpvInfoDialog } from "./mpv-info-dialog";

/** Mirrors how ServerMenu owns the dialog state: the dialog can open itself, the parent can close it. */
function MpvInfoDialogHarness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <MpvInfoDialog onOpenChange={setOpen} open={open} />;
}

const readyState: MpvState = { binaryPath: "/opt/homebrew/bin/mpv", source: "well-known", status: "ready", version: "0.40.0" };

const missingState: MpvState = {
  checkedPaths: ["mpv", "/opt/homebrew/bin/mpv"],
  installOptions: [{ automatic: true, command: "brew install mpv", method: "brew", note: null, url: null }],
  status: "missing",
};

describe("MpvInfoDialog", () => {
  // Vitest globals are disabled in this project, so React Testing Library cannot auto-clean.
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.cancelInstall.mockReset();
    mocks.clearManualPath.mockReset().mockResolvedValue(readyState);
    mocks.install.mockReset().mockResolvedValue(readyState);
    mocks.locate.mockReset().mockResolvedValue(readyState);
    mocks.recheck.mockReset().mockResolvedValue(readyState);
    mocks.subscribeInstallOutput.mockClear();
    mocks.playerState.error = null;
    mocks.playerState.installState = { status: "idle" };
    mocks.playerState.mpvState = { status: "checking" };
  });

  it("shows the resolved binary once mpv is available", async () => {
    mocks.playerState.mpvState = readyState;

    render(<MpvInfoDialogHarness initialOpen />);

    expect(await screen.findByText("/opt/homebrew/bin/mpv")).toBeTruthy();
    expect(screen.getByText("0.40.0")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
  });

  it("opens itself and offers a one-click install when mpv is missing", async () => {
    mocks.playerState.mpvState = missingState;

    render(<MpvInfoDialogHarness />);

    expect(await screen.findByText("Not installed")).toBeTruthy();
    expect(screen.getByText("brew install mpv")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith("brew"));
  });

  it("explains an unusable binary and lets the user pick another one", async () => {
    mocks.playerState.mpvState = {
      binaryPath: "/Users/tester/mpv",
      installOptions: [],
      reason: "The file is not executable.",
      source: "manual",
      status: "invalid",
    };

    render(<MpvInfoDialogHarness />);

    expect(await screen.findByText(/could not be run: The file is not executable\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Locate mpv/ }));
    await waitFor(() => expect(mocks.locate).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Reset to automatic" }));
    await waitFor(() => expect(mocks.clearManualPath).toHaveBeenCalledOnce());
  });

  it("copies commands that have to be run in a terminal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mocks.playerState.mpvState = {
      checkedPaths: [],
      installOptions: [{ automatic: false, command: "sudo apt install mpv", method: "apt", note: "Run this in a terminal, then re-check.", url: null }],
      status: "missing",
    };

    render(<MpvInfoDialogHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("sudo apt install mpv");
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("streams install output and can cancel a running install", async () => {
    mocks.playerState.mpvState = missingState;
    mocks.playerState.installState = { command: "brew install mpv", method: "brew", status: "running" };

    render(<MpvInfoDialogHarness />);
    await screen.findByText("Not installed");

    const emit = mocks.subscribeInstallOutput.mock.calls[0]?.[0];
    emit?.({ line: "==> Fetching mpv", stream: "stdout" });

    expect(await screen.findByText(/==> Fetching mpv/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel install" }));
    expect(mocks.cancelInstall).toHaveBeenCalledOnce();
  });
});
