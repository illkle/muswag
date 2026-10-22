import { viaDevBridge } from "#/data/dev-bridge";
import type { CoverSize } from "#shared/cover";
import type { CoverTarget } from "@muswag/model";

/**
 * Main serves a cover by what it is of, downloading it first when it has to
 * (`main/cover-protocol.ts`). A browser cannot load `muswag-cover:`, so there the dev bridge serves it.
 * The address carries the id the server gives the image, so that a changed cover is loaded again.
 */
export function toCoverArtUrl(type: CoverTarget["type"], id: string, coverArtId: string, size: CoverSize): string {
  const cover = `${type}/${encodeURIComponent(id)}?v=${encodeURIComponent(coverArtId)}${size === "full" ? "" : `&size=${size}`}`;
  return viaDevBridge ? `/__bridge/cover/${cover}` : `muswag-cover://${cover}`;
}
