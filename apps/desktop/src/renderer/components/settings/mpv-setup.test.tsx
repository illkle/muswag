// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BinaryState, MpvInstallOption } from "#shared/commands/player";

const mocks = vi.hoisted(() => ({
  clearManualPath: vi.fn(),
  locate: vi.fn(),
  openTerminal: vi.fn(),
  recheck: vi.fn(),
  playerState: {
    error: null as string | null,
    binary: { _tag: "Checking" } as BinaryState,
  },
}));

vi.mock("#/player/commands", () => ({
  MpvIPC: {
    clearManualPath: mocks.clearManualPath,
    locate: mocks.locate,
    openTerminal: mocks.openTerminal,
    recheck: mocks.recheck,
  },
}));

vi.mock("#/player/hooks", () => ({
  usePlayerError: () => (mocks.playerState.error ? { message: mocks.playerState.error, fix: null } : null),
  usePlayerMpvBinary: () => mocks.playerState.binary,
  usePlayerStatus: () => "idle",
}));

vi.mock("#/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { MpvInfoDialog, openMpvDialog } from "./mpv-info-dialog";
import { MpvInstall, MpvSearch } from "./mpv-setup";

/** Both parts, as the dialog shows them. */
const MpvSetup = () => (
  <>
    <MpvSearch />
    <MpvInstall />
  </>
);

const readyState: BinaryState = { _tag: "Ready", path: "/opt/homebrew/bin/mpv", source: "well-known", version: "0.40.0" };

const unavailable = (message: string, options: readonly MpvInstallOption[] = []): BinaryState => ({ _tag: "Unavailable", message, options, searched: ["/opt/homebrew/bin/mpv"] });

const brew: MpvInstallOption = { terminal: true, command: "brew install mpv", method: "brew", note: null, url: null };
const missingState = unavailable("mpv was not found. Install it, or select its executable.", [brew]);

// Vitest globals are disabled in this project, so React Testing Library cannot auto-clean.
afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mocks.clearManualPath.mockReset().mockResolvedValue(undefined);
  mocks.locate.mockReset().mockResolvedValue(undefined);
  mocks.openTerminal.mockReset().mockResolvedValue(undefined);
  mocks.recheck.mockReset().mockResolvedValue(undefined);
  mocks.playerState.error = null;
  mocks.playerState.binary = { _tag: "Checking" };
});

describe("MpvSetup", () => {
  it("says it is searching while main looks for mpv", () => {
    render(<MpvSetup />);
    expect(screen.getByText("Searching…")).toBeTruthy();
  });

  it("shows the binary it found, without ways to install another", () => {
    mocks.playerState.binary = readyState;

    render(<MpvSetup />);

    expect(screen.getByText("Found mpv 0.40.0")).toBeTruthy();
    expect(screen.getByText(/Found in a standard install location/)).toBeTruthy();
    expect(screen.queryByText("Install with a package manager")).toBeNull();
  });

  it("opens a terminal that installs mpv when it is missing", async () => {
    mocks.playerState.binary = missingState;

    render(<MpvSetup />);

    expect(screen.getByText("mpv was not found. Install it, or select its executable.")).toBeTruthy();
    expect(screen.getByText("Homebrew")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run in terminal" }));
    await waitFor(() => expect(mocks.openTerminal).toHaveBeenCalledWith("brew"));
  });

  it("says why the terminal could not be opened", async () => {
    mocks.playerState.binary = missingState;
    mocks.openTerminal.mockRejectedValue(new Error("No terminal could be found. Copy the command and run it in a terminal."));

    render(<MpvSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Run in terminal" }));

    expect(await screen.findByText("No terminal could be found. Copy the command and run it in a terminal.")).toBeTruthy();
  });

  it("only copies a command whose package manager is missing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mocks.playerState.binary = unavailable("mpv was not found. Install it, or select its executable.", [
      { terminal: false, command: "brew install mpv", method: "brew", note: "Homebrew is not installed.", url: "https://brew.sh" },
    ]);

    render(<MpvSetup />);

    expect(screen.queryByRole("button", { name: "Run in terminal" })).toBeNull();
    expect(screen.getByRole("link", { name: "https://brew.sh" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith("brew install mpv");
  });

  it("explains an unusable binary and lets the user pick another one or look again", async () => {
    mocks.playerState.binary = unavailable("The mpv on PATH cannot be used. mpv 0.37.0 is too old. Muswag requires mpv 0.38.0 or newer.");

    render(<MpvSetup />);

    expect(screen.getByText("The mpv on PATH cannot be used. mpv 0.37.0 is too old. Muswag requires mpv 0.38.0 or newer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Locate mpv/ }));
    await waitFor(() => expect(mocks.locate).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mocks.recheck).toHaveBeenCalledOnce());
  });

  it("looks again when the window comes back to the front, while mpv is missing", () => {
    mocks.playerState.binary = missingState;
    const view = render(<MpvSetup />);

    act(() => void window.dispatchEvent(new Event("focus")));
    expect(mocks.recheck).toHaveBeenCalledOnce();

    mocks.playerState.binary = readyState;
    view.rerender(<MpvSetup />);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(mocks.recheck).toHaveBeenCalledOnce();
  });

  it("lets the user go back to automatic discovery from a binary they picked", async () => {
    mocks.playerState.binary = { ...readyState, source: "manual" };

    render(<MpvSetup />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to automatic" }));
    await waitFor(() => expect(mocks.clearManualPath).toHaveBeenCalledOnce());
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
    expect(screen.getByText("Found mpv 0.40.0")).toBeTruthy();
    expect(screen.getByText("The track could not be played after retrying.")).toBeTruthy();
  });
});
