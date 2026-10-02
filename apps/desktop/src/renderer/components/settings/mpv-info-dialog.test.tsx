// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BinaryState, InstallState, MpvInstallOption } from "#shared/commands/player";

const mocks = vi.hoisted(() => ({
  cancelInstall: vi.fn(async () => {}),
  clearManualPath: vi.fn(),
  install: vi.fn(),
  locate: vi.fn(),
  playerState: {
    error: null as string | null,
    install: { _tag: "Idle" } as InstallState,
    binary: { _tag: "Checking" } as BinaryState,
  },
  recheck: vi.fn(),
  installOutput: [] as string[],
}));

vi.mock("#/player/commands", () => ({
  MpvIPC: {
    cancelInstall: mocks.cancelInstall,
    clearManualPath: mocks.clearManualPath,
    install: mocks.install,
    locate: mocks.locate,
    recheck: mocks.recheck,
  },
}));

vi.mock("#/player/hooks", () => ({
  usePlayerError: () => mocks.playerState.error,
  usePlayerInstallOutput: () => mocks.installOutput,
  usePlayerMpvBinary: () => mocks.playerState.binary,
  usePlayerMpvInstall: () => mocks.playerState.install,
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

const readyState: BinaryState = { _tag: "Ready", path: "/opt/homebrew/bin/mpv", source: "well-known", version: "0.40.0" };

const unavailable = (reason: "missing" | "invalid", message: string, options: readonly MpvInstallOption[] = []): BinaryState => ({
  _tag: "Unavailable",
  reason,
  issue: { actions: [], code: "BinaryUnavailable", id: "binary", message, occurrenceKey: null, operation: "discovery" },
  options,
});

const missingState = unavailable("missing", "Install mpv or select its executable.", [{ automatic: true, command: "brew install mpv", method: "brew", note: null, url: null }]);

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
    mocks.installOutput = [];
    mocks.playerState.error = null;
    mocks.playerState.install = { _tag: "Idle" };
    mocks.playerState.binary = { _tag: "Checking" };
  });

  it("shows the resolved binary once mpv is available", async () => {
    mocks.playerState.binary = readyState;

    render(<MpvInfoDialogHarness initialOpen />);

    expect(await screen.findByText("/opt/homebrew/bin/mpv")).toBeTruthy();
    expect(screen.getByText("0.40.0")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
  });

  it("opens itself and offers a one-click install when mpv is missing", async () => {
    mocks.playerState.binary = missingState;

    render(<MpvInfoDialogHarness />);

    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("brew install mpv")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith("brew"));
  });

  it("explains an unusable binary and lets the user pick another one", async () => {
    mocks.playerState.binary = unavailable("invalid", "The configured mpv cannot run or is older than 0.35.");

    render(<MpvInfoDialogHarness />);

    expect(await screen.findByText("The configured mpv cannot run or is older than 0.35.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Locate mpv/ }));
    await waitFor(() => expect(mocks.locate).toHaveBeenCalledOnce());
  });

  it("lets the user go back to automatic discovery from a binary they picked", async () => {
    mocks.playerState.binary = { ...readyState, source: "manual" };

    render(<MpvInfoDialogHarness initialOpen />);

    fireEvent.click(await screen.findByRole("button", { name: "Reset to automatic" }));
    await waitFor(() => expect(mocks.clearManualPath).toHaveBeenCalledOnce());
  });

  it("copies commands that have to be run in a terminal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mocks.playerState.binary = unavailable("missing", "Install mpv or select its executable.", [
      { automatic: false, command: "sudo apt install mpv", method: "apt", note: "Run this in a terminal, then re-check.", url: null },
    ]);

    render(<MpvInfoDialogHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("sudo apt install mpv");
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("shows install output and can cancel a running install", async () => {
    mocks.playerState.binary = missingState;
    mocks.playerState.install = { _tag: "Running", jobId: "job", method: "brew" };

    mocks.installOutput = ["==> Fetching mpv"];

    render(<MpvInfoDialogHarness />);
    await screen.findByText("Unavailable");

    expect(await screen.findByText(/==> Fetching mpv/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel install" }));
    expect(mocks.cancelInstall).toHaveBeenCalledOnce();
  });
});
