import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { coverMediaType, type CoverOwner } from "@muswag/backend";
import { nativeImage, protocol } from "electron";

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

/** What a cover address names: `<type>/<id>`, and whether the scaled-down copy is asked for. */
export interface CoverRequest {
  readonly type: string;
  readonly id: string;
  readonly thumbnail: boolean;
}

export type ServeCover = (request: CoverRequest) => Promise<Response>;

export interface CoverProtocolOptions {
  readonly userDataPath: string;
  /**
   * The file of an album's or artist's cover, relative to `userDataPath`, downloaded first when it is
   * not there. Null when there is no cover; rejects when it cannot be had.
   */
  readonly coverPath: (owner: CoverOwner) => Promise<string | null>;
}

/**
 * Serves covers by what they are of: `muswag-cover://album/<id>` and `muswag-cover://artist/<id>`,
 * with `thumbnail` in the query for a copy scaled down to `THUMBNAIL_SIZE`. Renderers name no file.
 * The rest of the query is theirs: they put the cover's id there, so a changed cover has a new address.
 * Returns the function that answers a request, for the dev bridge to serve the same to a browser.
 */
export function handleCoverProtocol({ userDataPath, coverPath }: CoverProtocolOptions): ServeCover {
  const thumbnailOf = makeThumbnails(resizeCover);
  const notFound = () => new Response(null, { status: 404 });

  const serveCover: ServeCover = async ({ type, id, thumbnail }) => {
    if (type !== "album" && type !== "artist") return notFound();
    try {
      const relativePath = await coverPath({ type, id });
      if (!relativePath) return notFound();
      const absolutePath = join(userDataPath, relativePath);
      // A cover that cannot be scaled down is served as it is.
      const image = (thumbnail ? await thumbnailOf(absolutePath).catch(() => null) : null) ?? (await readFile(absolutePath));
      return new Response(image, { headers: { "content-type": coverMediaType(image) ?? "application/octet-stream" } });
    } catch {
      // No session, a download that failed or a file that went: the renderer shows its placeholder for each.
      return notFound();
    }
  };

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    return serveCover({ type: url.hostname, id: decodeURIComponent(url.pathname.slice(1)), thumbnail: url.searchParams.has("thumbnail") });
  });
  return serveCover;
}
