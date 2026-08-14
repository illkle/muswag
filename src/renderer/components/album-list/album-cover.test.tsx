// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const coverArt = vi.hoisted(() => ({
  ensure: vi.fn(),
  repair: vi.fn(),
}));

vi.mock("#/lib/sync-manager", () => ({ CoverArt: coverArt }));

const { AlbumCover } = await import("#/components/album-list/album-cover");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AlbumCover", () => {
  it("repairs a failed cached image and retries with the replacement path", async () => {
    coverArt.repair.mockResolvedValue("/covers/repaired.jpg");
    render(<AlbumCover coverArtPath="/covers/missing.jpg" instantLoad target={{ type: "album", id: "album-1", coverArtId: "cover-1" }} />);

    const failedImage = screen.getByAltText("cover art");
    expect(failedImage.getAttribute("src")).toContain(encodeURIComponent("/covers/missing.jpg"));
    fireEvent.error(failedImage);

    expect(coverArt.repair).toHaveBeenCalledWith({ type: "album", id: "album-1", coverArtId: "cover-1" }, "/covers/missing.jpg");
    await waitFor(() => {
      const repairedImage = screen.getByAltText("cover art");
      expect(repairedImage.getAttribute("src")).toContain(encodeURIComponent("/covers/repaired.jpg"));
      expect(repairedImage.getAttribute("src")).toContain("revision=1");
    });
  });

  it("does not enter an automatic repair loop when the replacement also fails", async () => {
    coverArt.repair.mockResolvedValue("/covers/still-broken.jpg");
    render(<AlbumCover coverArtPath="/covers/missing.jpg" instantLoad target={{ type: "album", id: "album-1", coverArtId: "cover-1" }} />);

    fireEvent.error(screen.getByAltText("cover art"));
    await waitFor(() => expect(screen.getByAltText("cover art").getAttribute("src")).toContain("still-broken.jpg"));
    fireEvent.error(screen.getByAltText("cover art"));

    expect(coverArt.repair).toHaveBeenCalledTimes(1);
    expect(screen.queryByAltText("cover art")).toBeNull();
  });
});
