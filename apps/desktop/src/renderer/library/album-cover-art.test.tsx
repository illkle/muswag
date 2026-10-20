// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  albumCoverArts: vi.fn<(ids: readonly string[]) => Promise<Array<{ id: string; coverArt: string | null }>>>(),
  listeners: new Set<(event: unknown) => void>(),
}));
vi.mock("#/library/actions", () => ({ LibraryActions: { albumCoverArts: mocks.albumCoverArts } }));
vi.mock("#/data/library", () => ({
  mirrorClient: {
    subscribe: (listener: (event: unknown) => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));

const { useAlbumCoverArt } = await import("#/library/album-cover-art");

const Cover = ({ albumId }: { albumId: string }) => <span data-testid={albumId}>{useAlbumCoverArt(albumId) ?? "none"}</span>;
const covers = new Map<string, string | null>();
mocks.albumCoverArts.mockImplementation(async (ids) => ids.flatMap((id) => (covers.has(id) ? [{ id, coverArt: covers.get(id)! }] : [])));
const flush = () => act(async () => {});
const batch = (changes: Array<{ table: string; key: string }>) => {
  for (const listener of mocks.listeners) listener({ type: "batch", batch: { epoch: 1, fromSeq: 0, toSeq: 1, changes: changes.map((change, seq) => ({ seq, type: "changed", ...change })) } });
};

afterEach(cleanup);

describe("useAlbumCoverArt", () => {
  it("asks main once for the covers of every row drawn together, and keeps them", async () => {
    covers.set("a", "cover-a").set("b", "cover-b");
    render(
      <>
        <Cover albumId="a" />
        <Cover albumId="b" />
        <Cover albumId="gone" />
      </>,
    );
    await flush();

    expect(mocks.albumCoverArts).toHaveBeenCalledExactlyOnceWith(["a", "b", "gone"]);
    expect(screen.getByTestId("a").textContent).toBe("cover-a");
    expect(screen.getByTestId("gone").textContent).toBe("none");

    cleanup();
    render(<Cover albumId="a" />);
    await flush();
    expect(mocks.albumCoverArts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("a").textContent).toBe("cover-a");
  });

  it("asks again about an album that changed", async () => {
    render(<Cover albumId="a" />);
    await flush();
    mocks.albumCoverArts.mockClear();

    covers.set("a", "cover-a2");
    batch([
      { table: "albums", key: "a" },
      { table: "albums", key: "never-shown" },
      { table: "songs", key: "a" },
    ]);
    await flush();

    expect(mocks.albumCoverArts).toHaveBeenCalledExactlyOnceWith(["a"]);
    expect(screen.getByTestId("a").textContent).toBe("cover-a2");
  });

  it("asks about an album once while main has not answered, and again when it changed meanwhile", async () => {
    let answer: (() => void) | undefined;
    covers.set("slow", "cover-old");
    mocks.albumCoverArts.mockClear();
    mocks.albumCoverArts.mockImplementationOnce(
      (ids) =>
        new Promise((resolve) => {
          answer = () => resolve(ids.map((id) => ({ id, coverArt: covers.get(id) ?? null })));
        }),
    );
    render(<Cover albumId="slow" />);
    await flush();
    // Drawn again before the answer: not asked about a second time.
    render(<Cover albumId="slow" />);
    await flush();
    expect(mocks.albumCoverArts).toHaveBeenCalledTimes(1);

    // The album changes while main is being asked, and the answer is from before the change.
    batch([{ table: "albums", key: "slow" }]);
    answer!();
    covers.set("slow", "cover-new");
    await flush();
    expect(mocks.albumCoverArts).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("slow").map((element) => element.textContent)).toEqual(["cover-new", "cover-new"]);
  });

  it("asks again a moment after asking failed", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.albumCoverArts.mockClear();
    mocks.albumCoverArts.mockRejectedValueOnce(new Error("main is busy"));
    covers.set("retry", "cover-r");
    render(<Cover albumId="retry" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("retry").textContent).toBe("none");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.albumCoverArts).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("retry").textContent).toBe("cover-r");
    vi.useRealTimers();
  });

  it("asks again about a known album whose change could not be read", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    covers.set("known", "cover-1");
    render(<Cover albumId="known" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("known").textContent).toBe("cover-1");

    covers.set("known", "cover-2");
    mocks.albumCoverArts.mockClear();
    mocks.albumCoverArts.mockRejectedValueOnce(new Error("main is busy"));
    batch([{ table: "albums", key: "known" }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.albumCoverArts).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("known").textContent).toBe("cover-2");
    vi.useRealTimers();
  });
});
