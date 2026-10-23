import { describe, expect, it } from "vitest";

import { coverColours, foregroundOn, NO_COVER_COLOURS } from "./cover-colours";

type Rgb = readonly [number, number, number];

/** A cover made of the colours given, each covering its share of the pixels. */
function cover(parts: ReadonlyArray<[Rgb, number]>, size = 1000) {
  const data: number[] = [];
  for (const [[r, g, b], share] of parts) for (let i = 0; i < Math.round(share * size); i++) data.push(r, g, b, 255);
  return { data };
}

const red: Rgb = [200, 30, 30];
const blue: Rgb = [30, 60, 200];
const green: Rgb = [40, 170, 60];
const grey: Rgb = [120, 120, 120];
const black: Rgb = [10, 10, 10];

describe("coverColours", () => {
  it("takes the accent from the colour, not the larger greys", () => {
    expect(coverColours(cover([[grey, 0.5], [black, 0.3], [red, 0.2]])).accent).toBe("#c81e1e");
  });

  it("gives a grey cover no colours", () => {
    expect(coverColours(cover([[grey, 0.7], [black, 0.3]]))).toEqual(NO_COVER_COLOURS);
  });

  it("leaves out a hue of under 1% of the cover", () => {
    expect(coverColours(cover([[grey, 0.995], [red, 0.005]])).accent).toBeNull();
  });

  it("glows in the other colours of hues of their own", () => {
    const colours = coverColours(cover([[red, 0.5], [blue, 0.3], [green, 0.2]]));
    expect(colours.accent).toBe("#c81e1e");
    expect(colours.glow).toEqual(expect.arrayContaining(["#1e3cc8", "#28aa3c"]));
  });

  it("gives a one-colour cover no glow colours", () => {
    expect(coverColours(cover([[blue, 0.6], [black, 0.4]])).glow).toEqual([null, null]);
  });

  it("gives the same colours each time it reads a cover", () => {
    // Noise, which Material's k-means places its clusters in differently from each start it is given.
    let seed = 1;
    const channel = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 23;
    const data = Array.from({ length: 128 * 128 }, () => [channel(), channel(), channel(), 255]).flat();
    const reads = Array.from({ length: 5 }, () => JSON.stringify(coverColours({ data })));
    expect(new Set(reads).size).toBe(1);
  });

  it("reads BGRA", () => {
    const { data } = cover([[grey, 0.6], [red, 0.4]]);
    const bgra = data.map((_, i) => data[i % 4 === 0 ? i + 2 : i % 4 === 2 ? i - 2 : i]!);
    expect(coverColours({ data: bgra, order: "bgra" }).accent).toBe("#c81e1e");
  });
});

describe("foregroundOn", () => {
  it("is white on a dark colour and black on a light one", () => {
    expect(foregroundOn("#141e5a")).toBe("#ffffff");
    expect(foregroundOn("#f0e678")).toBe("#000000");
  });
});
