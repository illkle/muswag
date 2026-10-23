/**
 * The colours the interface takes from a cover: an accent for what is interactive or playing, and two colours
 * that glow behind the cover. Main reads them once per cover (`main/cover-colours.ts`) and keeps them with the
 * album; renderers only draw them.
 */
import { argbFromRgb, QuantizerCelebi, Score } from "@material/material-color-utilities";
import type { CoverColours } from "@muswag/model";

/** Pixels read row by row, four bytes each. `order` says which byte is which, since `nativeImage` gives BGRA. */
export interface CoverPixels {
  readonly data: ArrayLike<number>;
  readonly order?: "rgba" | "bgra";
}

/** The edge in pixels covers are scaled down to before they are read. */
export const COLOURS_SAMPLE_SIZE = 128;

/** What a cover too grey for any colour, or one that cannot be decoded, has. */
export const NO_COVER_COLOURS: CoverColours = { accent: null, glow: [null, null] };

/** How many colours Material's quantizer reduces a cover to. */
const QUANTIZED_COLOURS = 128;
/** What `Score` gives when no colour passes its filter: transparent black, which no opaque pixel is. */
const NO_COLOUR = 0;

/**
 * Material's way, as Android takes a theme from a wallpaper: the cover is reduced to 128 colours, and `Score`
 * ranks them by how much of the cover is near their hue and by how colourful they are, leaving out greys and
 * hues of under 1% of the cover. The accent is the best, the glow colours the next two, each of a hue apart
 * from the others.
 */
export function coverColours({ data, order = "rgba" }: CoverPixels): CoverColours {
  const [ri, bi] = order === "rgba" ? [0, 2] : [2, 0];
  const pixels: number[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3]! === 255) pixels.push(argbFromRgb(data[i + ri]!, data[i + 1]!, data[i + bi]!));
  }
  if (pixels.length === 0) return NO_COVER_COLOURS;

  const quantized = withSeededRandom(() => QuantizerCelebi.quantize(pixels, QUANTIZED_COLOURS));
  const scored = Score.score(quantized, { desired: 3, fallbackColorARGB: NO_COLOUR })
    .filter((argb) => argb !== NO_COLOUR)
    .map(hexOf);
  return { accent: scored[0] ?? null, glow: [scored[1] ?? null, scored[2] ?? null] };
}

/**
 * Runs `run` with a seeded `Math.random`. Material's k-means in JavaScript starts from `Math.random`, where its
 * Java and Dart versions seed theirs, so the same cover would give other colours each time it is read.
 */
function withSeededRandom<T>(run: () => T): T {
  const random = Math.random;
  // mulberry32, seeded as Material's Java version seeds its own.
  let state = 0x42688;
  Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return run();
  } finally {
    Math.random = random;
  }
}

const hexOf = (argb: number): string => `#${(argb & 0xffffff).toString(16).padStart(6, "0")}`;

/** A channel of `#rrggbb` as linear light, from 0 to 1. */
function linear(hex: string, channel: 0 | 1 | 2): number {
  const c = Number.parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Whichever of black and white contrasts more with `#rrggbb`. */
export function foregroundOn(hex: string): "#000000" | "#ffffff" {
  const luminance = 0.2126 * linear(hex, 0) + 0.7152 * linear(hex, 1) + 0.0722 * linear(hex, 2);
  // Where black on the colour has the same contrast as white.
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
