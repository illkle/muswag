/** A length in seconds as `m:ss` or `h:mm:ss`, or "-" when it is unknown. A part of a second is dropped. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return "-";
  }

  const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The parts that have a value, joined into one line of details. */
export function formatMetaLine(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" • ");
}
