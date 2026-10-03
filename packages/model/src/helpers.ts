import type { SessionCredentials } from "./contract.js";

const SUBSONIC_API_VERSION = "1.16.1";

/**
 * The URL is a pure function of its arguments: mpv recognises a prefetched track by its URL, so callers
 * reuse one salt to give a track the same URL every time.
 */
export function buildSubsonicStreamUrl(md5: (v: string) => string, credentials: SessionCredentials, songId: string, salt: string): string {
  const token = md5(`${credentials.password}${salt}`);
  const url = new URL("stream.view", getSubsonicRestBaseUrl(credentials.url));

  url.searchParams.set("id", songId);
  url.searchParams.set("u", credentials.username);
  url.searchParams.set("t", token);
  url.searchParams.set("s", salt);
  url.searchParams.set("v", SUBSONIC_API_VERSION);
  url.searchParams.set("c", "muswag");
  // mpv can decode the source formats itself. A live transcode is commonly sent as
  // an unknown-length response, which mpv cannot finish reading early enough to
  // prefetch the next playlist entry for gapless playback.
  url.searchParams.set("format", "raw");
  url.searchParams.set("maxBitRate", "0");
  url.searchParams.set("estimateContentLength", "true");

  return url.toString();
}

function getSubsonicRestBaseUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const ensuredTrailingSlash = normalizedBaseUrl.endsWith("/") ? normalizedBaseUrl : `${normalizedBaseUrl}/`;

  if (ensuredTrailingSlash.endsWith("/rest/")) {
    return ensuredTrailingSlash;
  }

  return new URL("rest/", ensuredTrailingSlash).toString();
}
