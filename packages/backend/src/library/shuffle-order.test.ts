import { describe, expect, it } from "vitest";

import { shuffleOrder } from "./shuffle-order.js";

const positions = (length: number) => Array.from({ length }, (_, position) => position);

describe("shuffleOrder", () => {
  it("visits everything once and finds it again, at every size", () => {
    for (const length of [...positions(70).slice(1), 1000, 1024, 1025, 100_000]) {
      const order = shuffleOrder(1234, length);
      const values = positions(length).map((position) => order.at(position));
      expect(new Set(values).size).toBe(length);
      expect(Math.max(...values)).toBe(length - 1);
      expect(values.every((value, position) => order.indexOf(value) === position)).toBe(true);
    }
  });

  it("makes an order of nothing", () => {
    expect(shuffleOrder(1234, 0)).toBeDefined();
  });

  it("gives the same order for a seed, and another for another seed", () => {
    const read = (seed: number) => positions(50).map(shuffleOrder(seed, 50).at);
    expect(read(7)).toEqual(read(7));
    expect(read(7)).not.toEqual(read(8));
  });

  it("puts the pinned thing first and still visits everything once", () => {
    for (const length of [1, 2, 3, 12, 100]) {
      for (const pinned of [0, Math.floor(length / 2), length - 1]) {
        const order = shuffleOrder(99, length, pinned);
        const values = positions(length).map((position) => order.at(position));
        expect(values[0]).toBe(pinned);
        expect(new Set(values).size).toBe(length);
        expect(values.every((value, position) => order.indexOf(value) === position)).toBe(true);
      }
    }
  });

  it("puts each thing at each position about as often, even in a small list", () => {
    for (const length of [2, 3, 5, 8, 12]) {
      const counts = positions(length).map(() => positions(length).map(() => 0));
      const seeds = 20_000;
      for (let seed = 0; seed < seeds; seed++) {
        const order = shuffleOrder(seed, length);
        for (const position of positions(length)) counts[position]![order.at(position)]! += 1;
      }
      const expected = seeds / length;
      for (const count of counts.flat()) expect(Math.abs(count - expected) / expected).toBeLessThan(0.1);
    }
  });

  it("does not keep neighbours together", () => {
    const length = 100_000;
    const order = shuffleOrder(5, length);
    const near = positions(length - 1).filter((position) => Math.abs(order.at(position) - order.at(position + 1)) <= 10).length;
    // Chance alone puts 20 in 100,000 of the pairs this close.
    expect(near).toBeLessThan(100);
  });
});
