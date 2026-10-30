/** Enough for an order that looks random, however small the source: few bits mix slowly. */
const ROUNDS = 8;

/** MurmurHash3's finaliser: every bit of `value` reaches every bit of the result. */
const scramble = (value: number) => {
  let hash = value;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

/** Every song id of the library in the order of `songs`' primary key, held outside the database. */
export type SongIdList = {
  readonly length: number;
  at(index: number): string;
  /** Where `id` is, or -1. */
  indexOf(id: string): number;
};

/**
 * A random order of `length` things that is computed, not stored: `at` says which thing is at a
 * position and `indexOf` where a thing is, in constant time, for a list of any size. `pinned` is the
 * thing that goes first.
 *
 * It is a Feistel network: the bits of a number are split in two, and each half in turn is changed by a
 * hash of the other, which can always be undone, so no two numbers end up the same. That shuffles the
 * numbers up to a power of two; one that lands past `length` goes through again until it does not, and
 * always gets there, as it is walking a cycle that holds the number it started from.
 */
export function shuffleOrder(seed: number, length: number, pinned: number | null = null) {
  const bits = 32 - Math.clz32(Math.max(0, length - 1));
  const lowBits = Math.ceil(bits / 2);
  const lowMask = 2 ** lowBits - 1;
  const highMask = 2 ** (bits - lowBits) - 1;
  const keys = Array.from({ length: ROUNDS }, (_, round) => scramble(seed + Math.imul(round + 1, 0x9e3779b9)));

  const round = (value: number, index: number) => {
    const low = value & lowMask;
    const high = value >>> lowBits;
    return index % 2 === 0 ? (((high ^ scramble(keys[index]! ^ low)) & highMask) << lowBits) | low : (high << lowBits) | ((low ^ scramble(keys[index]! ^ high)) & lowMask);
  };
  const encrypt = (value: number) => keys.reduce((result, _, index) => round(result, index), value);
  const decrypt = (value: number) => keys.reduceRight((result, _, index) => round(result, index), value);
  /** `step` from `value` until it lands in the list. */
  const walk = (step: (value: number) => number, value: number) => {
    let result = step(value);
    while (result >= length) result = step(result);
    return result;
  };

  /** What the pinned thing took the place of. A list with something pinned is never empty, and walking one that is would not end. */
  const head = pinned === null ? 0 : walk(encrypt, 0);
  return {
    at(position: number): number {
      if (pinned === null) return walk(encrypt, position);
      if (position === 0) return pinned;
      const value = walk(encrypt, position);
      return value === pinned ? head : value;
    },
    indexOf(value: number): number {
      if (pinned === null) return walk(decrypt, value);
      if (value === pinned) return 0;
      return walk(decrypt, value === head ? pinned : value);
    },
  };
}
