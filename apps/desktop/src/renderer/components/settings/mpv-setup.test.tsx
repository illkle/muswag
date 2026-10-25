// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  usePlayerError: () => (mocks.playerState.error ? { message: mocks.playerState.error, fix: null } : null),
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

import { MpvInfoDialog, openMpvDialog } from "./mpv-info-dialog";
import { MpvSetup } from "./mpv-setup";

const readyState: BinaryState = { _tag: "Ready", path: "/opt/homebrew/bin/mpv", source: "well-known", version: "0.40.0" };

const unavailable = (message: string, options: readonly MpvInstallOption[] = []): BinaryState => ({ _tag: "Unavailable", message, options });

const missingState = unavailable("mpv was not found. Install it, or select its executable.", [{ automatic: true, command: "brew install mpv", method: "brew", note: null, url: null }]);

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

describe("MpvSetup", () => {
  it("says it is looking for mpv while main checks", () => {
    render(<MpvSetup />);
    expect(screen.getByText("Looking for mpv on this computer…")).toBeTruthy();
  });

  it("shows the resolved binary once mpv is available", () => {
    mocks.playerState.binary = readyState;

    render(<MpvSetup />);

    expect(screen.getByText("mpv 0.40.0 is ready")).toBeTruthy();
    expect(screen.getByText("/opt/homebrew/bin/mpv")).toBeTruthy();
    expect(screen.getByText("Found in a standard install location")).toBeTruthy();
  });

  it("offers a one-click install when mpv is missing", async () => {
    mocks.playerState.binary = missingState;

    render(<MpvSetup />);

    expect(screen.getByText("mpv was not found. Install it, or select its executable.")).toBeTruthy();
    expect(screen.getByText("Install with Homebrew")).toBeTruthy();
    expect(screen.getByText("brew install mpv")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith("brew"));
  });

  it("explains an unusable binary and lets the user pick another one", async () => {
    mocks.playerState.binary = unavailable("The mpv on PATH cannot be used. mpv 0.37.0 is too old. Muswag requires mpv 0.38.0 or newer.");

    render(<MpvSetup />);

    expect(screen.getByText("The mpv on PATH cannot be used. mpv 0.37.0 is too old. Muswag requires mpv 0.38.0 or newer.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Locate mpv/ }));
    await waitFor(() => expect(mocks.locate).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mocks.recheck).toHaveBeenCalledOnce());
  });

  it("lets the user go back to automatic discovery from a binary they picked", async () => {
    mocks.playerState.binary = { ...readyState, source: "manual" };

    render(<MpvSetup />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to automatic" }));
    await waitFor(() => expect(mocks.clearManualPath).toHaveBeenCalledOnce());
  });

  it("copies commands that have to be run in a terminal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mocks.playerState.binary = unavailable("mpv was not found. Install it, or select its executable.", [
      { automatic: false, command: "sudo apt install mpv", method: "apt", note: "Run this in a terminal, then re-check.", url: null },
    ]);

    render(<MpvSetup />);

    expect(screen.getByText("Run this in a terminal, then re-check.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));

    expect(writeText).toHaveBeenCalledWith("sudo apt install mpv");
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("follows a running install and can cancel it", () => {
    mocks.playerState.binary = missingState;
    mocks.playerState.install = { _tag: "Running", jobId: "job", method: "brew" };
    mocks.installOutput = ["==> Fetching mpv"];

    render(<MpvSetup />);

    expect(screen.getByText("Installing mpv with Homebrew…")).toBeTruthy();
    expect(screen.getByText(/==> Fetching mpv/)).toBeTruthy();
    // Another install cannot start meanwhile.
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel install" }));
    expect(mocks.cancelInstall).toHaveBeenCalledOnce();
  });

  it("says why an installation failed, with its output", () => {
    mocks.playerState.binary = missingState;
    mocks.playerState.install = { _tag: "Failed", jobId: "job", method: "brew", message: "Package manager exited unsuccessfully. See installation output." };
    mocks.installOutput = ["Error: No such keg"];

    render(<MpvSetup />);

    expect(screen.getByText("Package manager exited unsuccessfully. See installation output.")).toBeTruthy();
    expect(screen.getByText(/No such keg/)).toBeTruthy();
  });
});

describe("MpvInfoDialog", () => {
  it("opens when asked to, and says what went wrong with playback last", () => {
    mocks.playerState.binary = readyState;
    mocks.playerState.error = "The track could not be played after retrying.";

    render(<MpvInfoDialog />);
    expect(screen.queryByText("Playback engine")).toBeNull();

    act(() => openMpvDialog());

    expect(screen.getByText("Playback engine")).toBeTruthy();
    expect(screen.getByText("mpv 0.40.0 is ready")).toBeTruthy();
    expect(screen.getByText("The track could not be played after retrying.")).toBeTruthy();
  });
});
