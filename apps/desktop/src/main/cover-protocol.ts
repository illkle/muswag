import { pathToFileURL } from "node:url";

import { nativeImage, net, protocol } from "electron";

import { resolveInside } from "./app/platform";
import { makeThumbnails, THUMBNAIL_SIZE, type ResizeCover } from "./cover-thumbnails";

const SCHEME = "muswag-cover";

/** Must run before the app is ready. */
export function registerCoverScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const isPng = (bytes: Buffer) => bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

/** `nativeImage` decodes only JPEG and PNG, so covers in other formats are shown as is. */
const resizeCover: ResizeCover = (cover) => {
  const image = nativeImage.createFromBuffer(cover);
  if (image.isEmpty()) return null;

  const { width, height } = image.getSize();
  const scale = THUMBNAIL_SIZE / Math.min(width, height);
  if (scale >= 1) return null;

  const resized = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" });
  // PNG covers stay PNG to keep their transparency.
  return isPng(cover) ? resized.toPNG() : resized.toJPEG(90);
};

/**
 * Serves cached cover files, which are relative to `userDataPath` and may not leave it.
 * With `thumbnail` in the query, the cover is served scaled down to `THUMBNAIL_SIZE`.
 */
export function handleCoverProtocol(userDataPath: string): void {
  const thumbnailOf = makeThumbnails(resizeCover);

  protocol.handle(SCHEME, async (request) => {
    const query = new URL(request.url).searchParams;
    const requestedPath = query.get("path");
    if (!requestedPath) {
      return new Response("Missing path", { status: 400 });
    }

    let absolutePath: string;
    try {
      absolutePath = resolveInside(userDataPath, requestedPath);
    } catch {
      return new Response("Invalid path", { status: 400 });
    }

    if (query.has("thumbnail")) {
      // A cover that cannot be read falls through, so the request fails the same way as without a thumbnail.
      const thumbnail = await thumbnailOf(absolutePath).catch(() => null);
      if (thumbnail) {
        return new Response(thumbnail, { headers: { "content-type": isPng(thumbnail) ? "image/png" : "image/jpeg" } });
      }
    }

    return net.fetch(pathToFileURL(absolutePath).toString());
  });
}
