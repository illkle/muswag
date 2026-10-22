/**
 * The colours the interface takes from a cover: an accent for what is interactive or playing, and two
 * colours for the glow behind it. Pure, so that it can run wherever the cover's pixels are: in the
 * renderer for now, in main once covers are read there.
 */
import { argbFromRgb, QuantizerCelebi, Score } from "@material/material-color-utilities";

/** Each channel from 0 to 255. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Pixels read row by row, four bytes each. `order` says which byte is which, since `nativeImage` gives BGRA. */
export interface CoverPixels {
  readonly data: ArrayLike<number>;
  readonly order?: "rgba" | "bgra";
}

export interface CoverPalette {
  /** Null when the cover is too grey to take a colour from: the interface keeps its own. */
  readonly accent: Rgb | null;
  /** Null where the cover has no other colour of a hue of its own. */
  readonly glow: readonly [Rgb | null, Rgb | null];
  /** The colours the cover was reduced to, largest first: for seeing what the choices were made from. */
  readonly colours: ReadonlyArray<{ readonly colour: Rgb; readonly share: number }>;
}

/** The edge in pixels covers are scaled down to before they are read. */
export const PALETTE_SAMPLE_SIZE = 128;

/** How many colours Material's quantizer reduces a cover to. */
const QUANTIZED_COLOURS = 128;
/** How many of them `colours` keeps. */
const COLOURS_KEPT = 12;
/** What `Score` gives when no colour passes its filter: transparent black, which no opaque pixel is. */
const NO_COLOUR = 0;

/**
 * Material's way, as Android takes a theme from a wallpaper: the cover is reduced to 128 colours, and
 * `Score` ranks them by how much of the cover is near their hue and by how colourful they are, leaving out
 * greys and hues of under 1% of the cover. The accent is the best, the glow colours the next two, each of a
 * hue apart from the others.
 */
export function coverPalette({ data, order = "rgba" }: CoverPixels): CoverPalette | null {
  const [ri, bi] = order === "rgba" ? [0, 2] : [2, 0];
  const pixels: number[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3]! === 255) pixels.push(argbFromRgb(data[i + ri]!, data[i + 1]!, data[i + bi]!));
  }
  if (pixels.length === 0) return null;

  const quantized = QuantizerCelebi.quantize(pixels, QUANTIZED_COLOURS);
  const scored = Score.score(quantized, { desired: 3, fallbackColorARGB: NO_COLOUR })
    .filter((argb) => argb !== NO_COLOUR)
    .map(rgbOf);
  const colours = [...quantized.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, COLOURS_KEPT)
    .map(([argb, count]) => ({ colour: rgbOf(argb), share: count / pixels.length }));

  return { accent: scored[0] ?? null, glow: [scored[1] ?? null, scored[2] ?? null], colours };
}

const rgbOf = (argb: number): Rgb => ({ r: (argb >> 16) & 0xff, g: (argb >> 8) & 0xff, b: argb & 0xff });

/** A channel as linear light, from 0 to 1. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Whichever of black and white contrasts more with the colour. */
export function foregroundOn(colour: Rgb): Rgb {
  const luminance = 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b);
  // Where black on the colour has the same contrast as white.
  return luminance > 0.179 ? BLACK : WHITE;
}

export const toCss = ({ r, g, b }: Rgb): string => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;

export const toHex = ({ r, g, b }: Rgb): string => "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
