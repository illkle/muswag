import type { Album } from "@muswag/model";

const releaseMonth = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });

/** Release date at the precision the server supplies, falling back to the original date or year. */
export function formatReleaseDate(album: Pick<Album, "releaseDate" | "originalReleaseDate" | "year">): string | null {
  const release = album.releaseDate;
  const original = album.originalReleaseDate;
  // Use a more precise original date only when it agrees with the known release components.
  const originalRefinesRelease =
    release?.year && original?.year === release.year && (!release.month || original.month === release.month) && ((!release.month && original.month) || (release.month && !release.day && original.day));
  const date = [originalRefinesRelease ? original : release, original].find((date) => date?.year && date.year > 0);
  const year = date?.year ?? album.year;
  if (!year) return null;
  if (!date?.month || date.month < 1 || date.month > 12) return String(year);
  const month = releaseMonth.format(new Date(Date.UTC(2000, date.month - 1, 1)));
  return [String(year), month, ...(date.day ? [String(date.day)] : [])].join(" ");
}

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

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** How long ago `iso` was, in the largest unit that fits: "just now", "5 minutes ago", "yesterday". */
export function formatAgo(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return relativeTime.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relativeTime.format(-hours, "hour");
  return relativeTime.format(-Math.round(hours / 24), "day");
}

const narrowRelativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });

/** `formatAgo` for a tight spot: "just now", "5m ago", "yesterday". */
export function formatAgoShort(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return narrowRelativeTime.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return narrowRelativeTime.format(-hours, "hour");
  return narrowRelativeTime.format(-Math.round(hours / 24), "day");
}
