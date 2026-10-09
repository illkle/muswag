import type { SessionCredentials } from "./contract.js";

const SUBSONIC_API_VERSION = "1.16.1";

/**
 * The address of a Subsonic server in the one form the app stores: scheme, host, port and path, with
 * no trailing slash and without the API's `rest` segment. An address without a scheme is taken as
 * https. `null` when `input` is not an http(s) address.
 *
 * Login is the only caller. What it stores is used as it is everywhere else, so the API client and
 * the stream URLs cannot read one address in two ways.
 */
export function normalizeServerUrl(input: string): string | null {
  const address = input.trim();
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `https://${address}`;
  if (!URL.canParse(withScheme)) return null;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `rest` as a whole segment: the address of the API was pasted. A path such as `/forest` stays.
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/rest$/, "")
    .replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** Where the API of the server at `serverUrl` is. `serverUrl` is a normalized address. */
export function subsonicRestUrl(serverUrl: string): string {
  return `${serverUrl}/rest/`;
}

/**
 * The URL is a pure function of its arguments: mpv recognises a prefetched track by its URL, so callers
 * reuse one salt to give a track the same URL every time.
 */
export function buildSubsonicStreamUrl(md5: (v: string) => string, credentials: SessionCredentials, songId: string, salt: string): string {
  const token = md5(`${credentials.password}${salt}`);
  const url = new URL("stream.view", subsonicRestUrl(credentials.url));

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
