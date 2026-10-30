import type { SongIdList } from "@muswag/backend";

/** The ids of the songs as one block of UTF-8 and where each one ends: a thread hands this over without a copy, and it costs the heap nothing. */
export type PackedSongIds = { readonly bytes: Uint8Array; readonly ends: Uint32Array };

/** `ids`, in the order of the primary key of `songs`. */
export function packSongIds(ids: readonly string[]): PackedSongIds {
  const ends = new Uint32Array(ids.length);
  let end = 0;
  ids.forEach((id, index) => {
    end += Buffer.byteLength(id);
    ends[index] = end;
  });
  return { bytes: new TextEncoder().encode(ids.join("")), ends };
}

/**
 * The ids `packed` holds. They are looked for by a binary search of their bytes, which is how SQLite
 * compares text in the primary key, so the search agrees with the order whatever characters ids have.
 */
export function songIdList({ bytes, ends }: PackedSongIds): SongIdList {
  const block = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startOf = (index: number) => (index === 0 ? 0 : ends[index - 1]!);
  return {
    length: ends.length,
    at: (index) => block.toString("utf8", startOf(index), ends[index]!),
    indexOf(id) {
      const wanted = Buffer.from(id);
      let low = 0;
      let high = ends.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const order = block.compare(wanted, 0, wanted.length, startOf(middle), ends[middle]!);
        if (order === 0) return middle;
        if (order < 0) low = middle + 1;
        else high = middle;
      }
      return -1;
    },
  };
}
