/** A length in seconds as `m:ss` or `h:mm:ss`, or "-" when it is unknown. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) {
    return "-";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The parts that have a value, joined into one line of details. */
export function formatMetaLine(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" • ");
}
