// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ playerError: null as { message: string } | null }));

// The player's state, which says what its banner shows.
vi.mock("#/data/state", () => ({ playerState: { player: { get: () => ({ error: mocks.playerError }) } } }));

const { Notices } = await import("#/components/notices");
const { failureNotice, notifyFailure } = await import("#/lib/notify");

afterEach(() => {
  cleanup();
  mocks.playerError = null;
});

/** What each notice on screen says. A screen reader is told the same in an element of its own, which this leaves out. */
const shown = () => [...document.querySelectorAll('[role="alertdialog"]')].map((notice) => notice.textContent);

describe("Notices", () => {
  it("shows a failure with what its cause says", async () => {
    render(<Notices />);

    act(() => notifyFailure("The song could not be added to the queue.", new Error("The server is not reachable.")));

    await waitFor(() => expect(shown()).toEqual(["The song could not be added to the queue.The server is not reachable."]));
  });

  it("reports the rejection of a command that nothing waits for", async () => {
    render(<Notices />);

    await act(() => Promise.reject(new Error("refused")).catch(failureNotice("The playlist could not be played.")));

    await waitFor(() => expect(shown()).toEqual(["The playlist could not be played.refused"]));
  });

  it("leaves a failure of the player to the player's banner, which says the same", async () => {
    render(<Notices />);
    mocks.playerError = { message: "Install or configure mpv before playing." };

    act(() => notifyFailure("The album could not be played.", new Error("Install or configure mpv before playing.")));
    act(() => notifyFailure("The song could not be added to the queue.", new Error("The server is not reachable.")));

    await waitFor(() => expect(shown()).toEqual(["The song could not be added to the queue.The server is not reachable."]));
  });

  it("keeps one notice for a failure that repeats", async () => {
    render(<Notices />);

    act(() => notifyFailure("The song could not be played.", new Error("first")));
    act(() => notifyFailure("The song could not be played.", new Error("second")));

    await waitFor(() => expect(shown()).toEqual(["The song could not be played.second"]));
  });
});
