import { createHash, randomBytes } from "node:crypto";

/** A user of a test server: `password` is what goes in muswag's password field, which on LMS is an API key. */
export interface Account {
  readonly username: string;
  readonly password: string;
}

type Params = Record<string, string | number | boolean | ReadonlyArray<string | number> | undefined>;

/**
 * The harness's own Subsonic client, for setting servers up and checking on them. It is kept apart
 * from muswag's client so that a fault in the client under test cannot hide behind the harness.
 */
export async function subsonic<T = Record<string, unknown>>(url: string, account: Account, method: string, params: Params = {}): Promise<T> {
  const salt = randomBytes(8).toString("hex");
  const body = new URLSearchParams({
    u: account.username,
    t: createHash("md5")
      .update(account.password + salt)
      .digest("hex"),
    s: salt,
    v: "1.16.1",
    c: "muswag-tests",
    f: "json",
  });
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
  }
  const response = await fetch(`${url}/rest/${method}.view`, { method: "POST", body, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const payload = (await response.json()) as { "subsonic-response": { status: string; error?: { code?: number; message?: string } } & T };
  const answer = payload["subsonic-response"];
  if (answer.status !== "ok") throw new Error(`${method}: ${answer.error?.message ?? answer.status} (code ${answer.error?.code})`);
  return answer;
}

/**
 * Waits until the server answers Subsonic requests. Some open their port before they do: LMS shows a
 * page saying it is starting while it sets its database up.
 */
export async function waitForApi(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/rest/ping.view?f=json&v=1.16.1&c=muswag-tests`, { signal: AbortSignal.timeout(5_000) });
      const text = await response.text();
      // Any Subsonic answer will do, the one refusing a request without credentials included.
      if (text.includes('"subsonic-response"')) return;
      last = `HTTP ${response.status}: ${text.slice(0, 120)}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${url} did not answer Subsonic requests within ${timeoutMs} ms. Last answer: ${last}`);
}

interface ListedAlbum {
  id: string;
  name: string;
}

interface ListedSong {
  id: string;
  title: string;
  albumId?: string;
}

/** Every album the server lists, a page at a time. */
export async function listAlbums(url: string, account: Account): Promise<ListedAlbum[]> {
  const albums: ListedAlbum[] = [];
  for (let offset = 0; ;) {
    const { albumList2 } = await subsonic<{ albumList2: { album?: ListedAlbum[] } }>(url, account, "getAlbumList2", { type: "alphabeticalByName", size: 500, offset });
    const page = albumList2.album ?? [];
    if (page.length === 0) return albums;
    albums.push(...page);
    offset += page.length;
  }
}

/** Every song the server lists through `search3` with an empty query, a page at a time. */
export async function listSongs(url: string, account: Account): Promise<ListedSong[]> {
  const songs: ListedSong[] = [];
  for (let offset = 0; ;) {
    const { searchResult3 } = await subsonic<{ searchResult3: { song?: ListedSong[] } }>(url, account, "search3", {
      query: "",
      artistCount: 0,
      albumCount: 0,
      songCount: 500,
      songOffset: offset,
    });
    const page = searchResult3.song ?? [];
    if (page.length === 0) return songs;
    songs.push(...page);
    offset += page.length;
  }
}
