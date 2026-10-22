import { describe, expect, it } from "vitest";

import { coverPalette, foregroundOn, type Rgb } from "./cover-palette";

/** A cover made of the colours given, each covering its share of the pixels. */
function cover(parts: ReadonlyArray<[Rgb, number]>, size = 1000) {
  const data: number[] = [];
  for (const [{ r, g, b }, share] of parts) for (let i = 0; i < Math.round(share * size); i++) data.push(r, g, b, 255);
  return { data };
}

const red: Rgb = { r: 200, g: 30, b: 30 };
const blue: Rgb = { r: 30, g: 60, b: 200 };
const green: Rgb = { r: 40, g: 170, b: 60 };
const grey: Rgb = { r: 120, g: 120, b: 120 };
const black: Rgb = { r: 10, g: 10, b: 10 };

describe("coverPalette", () => {
  it("takes the accent from the colour, not the larger greys", () => {
    const palette = coverPalette(cover([[grey, 0.5], [black, 0.3], [red, 0.2]]))!;
    expect(palette.accent).toEqual(red);
  });

  it("gives a grey cover no accent and no glow", () => {
    const palette = coverPalette(cover([[grey, 0.7], [black, 0.3]]))!;
    expect(palette.accent).toBeNull();
    expect(palette.glow).toEqual([null, null]);
  });

  it("leaves out a hue of under 1% of the cover", () => {
    expect(coverPalette(cover([[grey, 0.995], [red, 0.005]]))!.accent).toBeNull();
  });

  it("glows in the other colours of hues of their own", () => {
    const palette = coverPalette(cover([[red, 0.5], [blue, 0.3], [green, 0.2]]))!;
    expect(palette.accent).toEqual(red);
    expect(palette.glow).toEqual(expect.arrayContaining([blue, green]));
  });

  it("gives a one-colour cover no glow colours", () => {
    expect(coverPalette(cover([[blue, 0.6], [black, 0.4]]))!.glow).toEqual([null, null]);
  });

  it("keeps the colours it reduced the cover to, largest first", () => {
    const { colours } = coverPalette(cover([[grey, 0.7], [red, 0.3]]))!;
    expect(colours).toEqual([
      { colour: grey, share: 0.7 },
      { colour: red, share: 0.3 },
    ]);
  });

  it("reads BGRA", () => {
    const { data } = cover([[grey, 0.6], [red, 0.4]]);
    const bgra = data.map((_, i) => data[i % 4 === 0 ? i + 2 : i % 4 === 2 ? i - 2 : i]!);
    expect(coverPalette({ data: bgra, order: "bgra" })!.accent).toEqual(red);
  });
});

describe("foregroundOn", () => {
  it("is white on a dark colour and black on a light one", () => {
    expect(foregroundOn({ r: 20, g: 30, b: 90 })).toEqual({ r: 255, g: 255, b: 255 });
    expect(foregroundOn({ r: 240, g: 230, b: 120 })).toEqual({ r: 0, g: 0, b: 0 });
  });
});
