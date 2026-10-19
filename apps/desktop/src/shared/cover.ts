/**
 * How large a cover is asked for: as it was downloaded, or scaled down to a thumbnail for a grid tile
 * or to an icon for a list row. A cover is decoded at the size it is served, whatever size it is shown.
 */
export type CoverSize = "full" | "thumbnail" | "icon";

/** The sizes main scales covers down to. */
export type ThumbnailSize = Exclude<CoverSize, "full">;

/** The size a cover address asks for in its `size` parameter: the full cover when it names none it knows. */
export const coverSizeOf = (size: string | null): CoverSize => (size === "thumbnail" || size === "icon" ? size : "full");
