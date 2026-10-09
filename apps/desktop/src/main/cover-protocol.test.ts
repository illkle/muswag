import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (request: { url: string }) => Promise<Response>>(),
  // Stands for an image too small to need a thumbnail.
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
}));

vi.mock("electron", () => ({
  nativeImage: electron.nativeImage,
  protocol: { handle: (scheme: string, handler: (request: { url: string }) => Promise<Response>) => void electron.handlers.set(scheme, handler) },
}));

const { handleCoverProtocol } = await import("./cover-protocol");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let userDataPath: string;

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), "muswag-covers-"));
  await mkdir(join(userDataPath, "covers"));
  await writeFile(join(userDataPath, "covers", "album_3a_a1"), JPEG);
});

afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true });
});

describe("handleCoverProtocol", () => {
  it("serves the cover of the album or artist the address names", async () => {
    const coverPath = vi.fn(async () => "covers/album_3a_a1");
    handleCoverProtocol({ userDataPath, coverPath });
    const fetchCover = electron.handlers.get("muswag-cover")!;

    const response = await fetchCover({ url: "muswag-cover://album/a%201?v=cover-1&thumbnail" });

    expect(coverPath).toHaveBeenCalledWith({ type: "album", id: "a 1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG);
  });

  it("answers 404 when there is no cover, it cannot be had, or its file is gone", async () => {
    const serveCover = handleCoverProtocol({
      userDataPath,
      coverPath: async ({ id }) => {
        if (id === "none") return null;
        if (id === "gone") return "covers/missing";
        throw new Error("Log in before using server services");
      },
    });

    for (const id of ["none", "gone", "failing"]) expect((await serveCover({ type: "album", id, thumbnail: false })).status).toBe(404);
  });

  it("asks for no cover of anything but an album or an artist", async () => {
    const coverPath = vi.fn(async () => "covers/album_3a_a1");
    const serveCover = handleCoverProtocol({ userDataPath, coverPath });

    expect((await serveCover({ type: "local", id: "a1", thumbnail: false })).status).toBe(404);
    expect(coverPath).not.toHaveBeenCalled();
  });
});
