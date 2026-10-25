import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import type { AlbumFixture } from "../library/fixtures.js";
import { writeLibrary } from "../library/files.js";
import { type Account, listAlbums, listSongs, subsonic, waitForApi } from "./subsonic.js";

export type ServerName = "navidrome" | "gonic" | "lms";

/** What a server does that the others do not, for tests to expect it of that server. */
export interface ServerTraits {
  /** `getScanStatus` says when the server last scanned, so a quick sync can tell that a song changed in an album that looks the same. */
  readonly reportsLastScan: boolean;
  /** The server keeps a playlist's comment. LMS takes no comment and sends none. */
  readonly keepsPlaylistComments: boolean;
  /** The server reads every artist of a song with several. gonic reads only the first unless it is set up to read them all. */
  readonly splitsArtists: boolean;
}

/** How to run one kind of server in a container. */
export interface ServerDefinition {
  readonly name: ServerName;
  readonly image: string;
  readonly port: number;
  /** The folder the server reads music from. */
  readonly musicPath: string;
  readonly traits: ServerTraits;
  /** An administrator, and a user who is not one. */
  readonly admin: Account;
  readonly guest: Account;
  /** Adds the server's settings to its container before it starts. */
  readonly configure: (container: GenericContainer) => Promise<GenericContainer>;
  /** Makes the server ready for both accounts once it listens. */
  readonly setUp: (url: string) => Promise<void>;
  readonly startScanParams?: Record<string, string | boolean>;
}

/** A server running in a container for a test file. */
export interface TestServer {
  readonly name: ServerName;
  readonly url: string;
  readonly admin: Account;
  readonly guest: Account;
  readonly traits: ServerTraits;
  /** Has the music folder hold exactly `albums`, has the server scan it and waits until the server lists exactly them. */
  setLibrary(albums: readonly AlbumFixture[]): Promise<void>;
  /** Deletes every playlist of both accounts. */
  clearPlaylists(): Promise<void>;
  stop(): Promise<void>;
}

const LIBRARY_TIMEOUT_MS = 120_000;
/** How long a server may sit idle with the old library listed before it is asked to scan again. */
const RESCAN_AFTER_MS = 10_000;

export async function startServer(definition: ServerDefinition): Promise<TestServer> {
  const configured = await definition.configure(new GenericContainer(definition.image).withExposedPorts(definition.port).withWaitStrategy(Wait.forListeningPorts()));
  const container = await configured.start();
  const url = `http://${container.getHost()}:${container.getMappedPort(definition.port)}`;
  try {
    await waitForApi(url);
    await definition.setUp(url);
    for (const account of [definition.admin, definition.guest]) await subsonic(url, account, "ping");
  } catch (error) {
    await container.stop();
    throw error;
  }
  const { name, admin, guest, traits } = definition;
  // Servers tell a changed file by its time, some to the second, so each library is written two seconds after the last.
  let modified = 0;
  /** The library the server lists, as `setLibrary` last had it list one. */
  let current: string | undefined;

  return {
    name,
    url,
    admin,
    guest,
    traits,
    async setLibrary(albums) {
      // The server would list the same library before and after its scan, so a wait could not tell
      // the scan had run, and the next test would change the files under it.
      const wanted = JSON.stringify(albums);
      if (wanted === current) return;
      current = undefined;
      const source = await mkdtemp(path.join(tmpdir(), `muswag-${name}-library-`));
      try {
        modified = Math.max(Date.now(), modified + 2_000);
        await writeLibrary(source, albums, new Date(modified));
        await run(container, ["sh", "-c", `rm -rf ${definition.musicPath}/* ${definition.musicPath}/.[!.]*`]);
        await container.copyDirectoriesToContainer([{ source, target: definition.musicPath }]);
        await waitForLibrary(url, admin, albums, () => subsonic(url, admin, "startScan", definition.startScanParams));
        current = wanted;
      } finally {
        await rm(source, { recursive: true, force: true });
      }
    },
    async clearPlaylists() {
      for (const account of [admin, guest]) {
        const { playlists } = await subsonic<{ playlists: { playlist?: { id: string; owner?: string }[] } }>(url, account, "getPlaylists");
        for (const { id, owner } of playlists.playlist ?? []) {
          if (owner === account.username) await subsonic(url, account, "deletePlaylist", { id });
        }
      }
    },
    async stop() {
      await container.stop();
    },
  };
}

/** Runs `command` in the container as root, which may change files the server's own user may not. */
async function run(container: StartedTestContainer, command: string[]): Promise<void> {
  const result = await container.exec(command, { user: "root" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with ${result.exitCode}: ${result.output}`);
}

/**
 * The albums with the number of songs listed of each, and the songs with their albums, in an order
 * that does not depend on the server's. The count is not the album's `songCount`: Navidrome keeps
 * counting a song whose file is gone.
 */
async function listedLibrary(url: string, account: Account): Promise<string> {
  const [albums, listed] = await Promise.all([listAlbums(url, account), listSongs(url, account)]);
  const songs = [...new Map(listed.map((song) => [song.id, song])).values()];
  const names = new Map(albums.map(({ id, name }) => [id, name]));
  return JSON.stringify({
    albums: albums.map(({ id, name }) => `${name} (${songs.filter(({ albumId }) => albumId === id).length})`).sort(),
    // Of an album the server does not list, a song shows as of "?", which no fixture has.
    songs: songs.map(({ albumId, title }) => `${names.get(albumId ?? "") ?? "?"} / ${title}`).sort(),
  });
}

const scanning = async (url: string, account: Account) => (await subsonic<{ scanStatus: { scanning: boolean } }>(url, account, "getScanStatus")).scanStatus.scanning;

/**
 * Has the server scan with `scan`, and waits until it lists the albums and songs of `albums`, and no
 * others, and is not scanning before or after it lists them. The library is compared and not the scan
 * status alone, which some servers report as done before they start. A server that sits idle with
 * another library listed is asked to scan again: Navidrome once let a scan go by, and listed the old
 * library until the wait ran out.
 */
async function waitForLibrary(url: string, account: Account, albums: readonly AlbumFixture[], scan: () => Promise<unknown>): Promise<void> {
  const expected = JSON.stringify({
    albums: albums.map(({ title, songs }) => `${title} (${songs.length})`).sort(),
    songs: albums.flatMap(({ title, songs }) => songs.map((song) => `${title} / ${song.title}`)).sort(),
  });
  const deadline = Date.now() + LIBRARY_TIMEOUT_MS;
  let listed = "";
  await scan();
  let scannedAt = Date.now();
  while (Date.now() < deadline) {
    if (!(await scanning(url, account))) {
      listed = await listedLibrary(url, account);
      if (listed === expected && !(await scanning(url, account))) return;
      if (Date.now() - scannedAt > RESCAN_AFTER_MS) {
        await scan();
        scannedAt = Date.now();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`The server did not list the library within ${LIBRARY_TIMEOUT_MS} ms.\nExpected: ${expected}\nListed:   ${listed}`);
}
