/** Strings already seen, by their value, so that equal strings can share one copy. */
export type Interned = Map<string, string>;

/**
 * Gives every string in `value`, in its plain objects and arrays at any depth, the copy `interned`
 * holds of it, and returns `value`, changed in place. Rows arrive by structured clone, which makes a
 * copy of each string for each row: an artist's name and id are held once for every one of its songs.
 */
export function internStrings<T>(value: T, interned: Interned): T {
  internContents(value, interned);
  return value;
}

function internContents(value: unknown, interned: Interned): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) value[index] = internValue(value[index], interned);
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) value[key] = internValue(value[key], interned);
  }
}

function internValue(value: unknown, interned: Interned): unknown {
  if (typeof value === "string") {
    const known = interned.get(value);
    if (known !== undefined) return known;
    interned.set(value, value);
    return value;
  }
  internContents(value, interned);
  return value;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
