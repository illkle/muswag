// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AlbumCover } from "#/components/album-list/album-cover";

afterEach(cleanup);

const album = { type: "album", id: "album 1", coverArtId: "cover-1" } as const;
const src = () => screen.getByAltText("cover art").getAttribute("src");

describe("AlbumCover", () => {
  it("addresses the cover by what it is of", () => {
    render(<AlbumCover instantLoad target={album} />);
    expect(src()).toBe("muswag-cover://album/album%201?v=cover-1");

    cleanup();
    render(<AlbumCover instantLoad target={{ ...album, type: "artist" }} />);
    expect(src()).toBe("muswag-cover://artist/album%201?v=cover-1");
  });

  it("asks for the scaled-down cover only when shown as a thumbnail", () => {
    const { rerender } = render(<AlbumCover instantLoad thumbnail target={album} />);
    expect(src()).toContain("thumbnail");

    rerender(<AlbumCover instantLoad target={album} />);
    expect(src()).not.toContain("thumbnail");
  });

  it("asks for nothing when there is no cover", () => {
    const { rerender } = render(<AlbumCover instantLoad target={{ ...album, coverArtId: null }} />);
    expect(screen.queryByAltText("cover art")).toBeNull();

    rerender(<AlbumCover instantLoad />);
    expect(screen.queryByAltText("cover art")).toBeNull();
  });

  it("shows the placeholder for a cover that did not load, and does not ask again", () => {
    const { rerender } = render(<AlbumCover instantLoad target={album} />);
    fireEvent.error(screen.getByAltText("cover art"));
    expect(screen.queryByAltText("cover art")).toBeNull();

    rerender(<AlbumCover instantLoad target={{ ...album }} />);
    expect(screen.queryByAltText("cover art")).toBeNull();
  });

  it("loads again when the cover is another one", () => {
    const { rerender } = render(<AlbumCover instantLoad target={album} />);
    fireEvent.error(screen.getByAltText("cover art"));

    rerender(<AlbumCover instantLoad target={{ ...album, coverArtId: "cover-2" }} />);
    expect(src()).toBe("muswag-cover://album/album%201?v=cover-2");
  });
});
