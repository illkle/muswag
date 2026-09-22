// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appClient = vi.hoisted(() => ({
  ensureCover: vi.fn(),
  repairCover: vi.fn(),
}));

vi.mock("#/core/client", () => ({ AppClient: appClient }));

const { AlbumCover } = await import("#/components/album-list/album-cover");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AlbumCover", () => {
  it("repairs a failed cached image and retries with the replacement path", async () => {
    appClient.repairCover.mockResolvedValue("/covers/repaired.jpg");
    render(<AlbumCover coverArtPath="/covers/missing.jpg" instantLoad target={{ type: "album", id: "album-1", coverArtId: "cover-1" }} />);

    const failedImage = screen.getByAltText("cover art");
    expect(failedImage.getAttribute("src")).toContain(encodeURIComponent("/covers/missing.jpg"));
    fireEvent.error(failedImage);

    expect(appClient.repairCover).toHaveBeenCalledWith({ type: "album", id: "album-1", coverArtId: "cover-1" }, "/covers/missing.jpg");
    await waitFor(() => {
      const repairedImage = screen.getByAltText("cover art");
      expect(repairedImage.getAttribute("src")).toContain(encodeURIComponent("/covers/repaired.jpg"));
      expect(repairedImage.getAttribute("src")).toContain("revision=1");
    });
  });

  it("does not enter an automatic repair loop when the replacement also fails", async () => {
    appClient.repairCover.mockResolvedValue("/covers/still-broken.jpg");
    render(<AlbumCover coverArtPath="/covers/missing.jpg" instantLoad target={{ type: "album", id: "album-1", coverArtId: "cover-1" }} />);

    fireEvent.error(screen.getByAltText("cover art"));
    await waitFor(() => expect(screen.getByAltText("cover art").getAttribute("src")).toContain("still-broken.jpg"));
    fireEvent.error(screen.getByAltText("cover art"));

    expect(appClient.repairCover).toHaveBeenCalledTimes(1);
    expect(screen.queryByAltText("cover art")).toBeNull();
  });
});
