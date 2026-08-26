import type { SessionCredentials } from "./credentialsManager.js";

const SUBSONIC_API_VERSION = "1.16.1";
const HEX = "0123456789abcdef";

export function buildSubsonicStreamUrl(md5: (v: string) => string, credentials: SessionCredentials, songId: string): string {
  const salt = randomHex(16);
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

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;

  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let output = "";
  for (const byte of bytes) {
    output += HEX[byte >>> 4] ?? "0";
    output += HEX[byte & 0x0f] ?? "0";
  }
  return output;
}
