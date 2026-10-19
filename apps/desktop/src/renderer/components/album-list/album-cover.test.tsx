// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AlbumCover } from "#/components/album-list/album-cover";

afterEach(cleanup);

const album = { type: "album", id: "album 1", coverArtId: "cover-1" } as const;
const src = () => screen.getByAltText("cover art").getAttribute("src");

describe("AlbumCover", () => {
  it("addresses the cover by what it is of", () => {
    render(<AlbumCover target={album} />);
    expect(src()).toBe("muswag-cover://album/album%201?v=cover-1");

    cleanup();
    render(<AlbumCover target={{ ...album, type: "artist" }} />);
    expect(src()).toBe("muswag-cover://artist/album%201?v=cover-1");
  });

  it("asks for a scaled-down cover only when shown smaller", () => {
    const { rerender } = render(<AlbumCover size="thumbnail" target={album} />);
    expect(src()).toBe("muswag-cover://album/album%201?v=cover-1&size=thumbnail");

    rerender(<AlbumCover size="icon" target={album} />);
    expect(src()).toBe("muswag-cover://album/album%201?v=cover-1&size=icon");

    rerender(<AlbumCover target={album} />);
    expect(src()).not.toContain("size");
  });

  it("asks for nothing when there is no cover", () => {
    const { rerender } = render(<AlbumCover target={{ ...album, coverArtId: null }} />);
    expect(screen.queryByAltText("cover art")).toBeNull();

    rerender(<AlbumCover />);
    expect(screen.queryByAltText("cover art")).toBeNull();
  });

  it("shows the placeholder for a cover that did not load, and does not ask again", () => {
    const { rerender } = render(<AlbumCover target={album} />);
    fireEvent.error(screen.getByAltText("cover art"));
    expect(screen.queryByAltText("cover art")).toBeNull();

    rerender(<AlbumCover target={{ ...album }} />);
    expect(screen.queryByAltText("cover art")).toBeNull();
  });

  it("loads again when the cover is another one", () => {
    const { rerender } = render(<AlbumCover target={album} />);
    fireEvent.error(screen.getByAltText("cover art"));

    rerender(<AlbumCover target={{ ...album, coverArtId: "cover-2" }} />);
    expect(src()).toBe("muswag-cover://album/album%201?v=cover-2");
  });
});
