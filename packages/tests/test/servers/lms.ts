import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";

import { GenericContainer, getContainerRuntimeClient, type StoppedTestContainer, Wait } from "testcontainers";

import type { ServerDefinition } from "./server.js";
import { waitForApi } from "./subsonic.js";

const IMAGE = "epoupon/lms:3.81.0";

/**
 * LMS takes Subsonic requests only with an API key, which on a client without the API key extension
 * goes where the password would. A user makes keys in LMS's web interface; the tests write them to its database.
 */
const admin = { username: "admin", password: "muswag-admin-api-key-0123456789" };
const guest = { username: "guest", password: "muswag-guest-api-key-0123456789" };

// LMS's numbers for what its users table stores, from its source.
const USER_TYPE = { regular: 0, admin: 1 };
const OGG_OPUS = 2;
const DARK_THEME = 1;
const ORIGINAL_DATE_DESC = 8;
const ALL_ARTISTS = 0;
const INTERNAL_BACKEND = 1;

let seeded: Promise<Buffer> | undefined;

/**
 * An LMS database with both users, their API keys and a media library at `/music`, which LMS would
 * otherwise have an administrator make in its web interface. It is made once per test file: an LMS
 * with no music starts, makes its database and stops, and the rows are added to that database.
 */
function seededDatabase(): Promise<Buffer> {
  seeded ??= (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "muswag-lms-db-"));
    const container = await new GenericContainer(IMAGE).withExposedPorts(5082).withWaitStrategy(Wait.forListeningPorts()).start();
    let stopped: StoppedTestContainer | undefined;
    try {
      // Its database is complete once it answers requests.
      await waitForApi(`http://${container.getHost()}:${container.getMappedPort(5082)}`);
      // Given time to stop, LMS writes its database out; the log beside it is taken along all the same.
      stopped = await container.stop({ remove: false, timeout: 20_000 });
      const tar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "inherit"] });
      const extracted = new Promise<void>((resolve, reject) => tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)))));
      await pipeline(await stopped.copyArchiveFromContainer("/var/lms"), tar.stdin);
      await extracted;
      return addAccounts(path.join(dir, "lms", "lms.db"));
    } finally {
      if (stopped) {
        const client = await getContainerRuntimeClient();
        await client.container.remove(client.container.getById(stopped.getId()), { removeVolumes: true });
      } else {
        await container.stop();
      }
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return seeded;
}

/** Adds both accounts and the media library to the database in `file`, and answers with the database. */
async function addAccounts(file: string): Promise<Buffer> {
  const db = new DatabaseSync(file);
  try {
    const addUser = db.prepare(
      `INSERT INTO user (version, type, login_name, bcrypt_round_count, password_salt, password_hash, subsonic_enable_transcoding_by_default,
         subsonic_default_transcode_format, subsonic_default_transcode_bitrate, subsonic_artist_list_mode, ui_theme, ui_artist_release_sort_method,
         ui_enable_inline_artist_relationships, ui_inline_artist_relationships, feedback_backends, scrobbling_backends, listenbrainz_token,
         lastfm_api_key, lastfm_api_secret, lastfm_session_key)
       VALUES (0, ?, ?, 12, '', '', 0, ${OGG_OPUS}, 128000, ${ALL_ARTISTS}, ${DARK_THEME}, ${ORIGINAL_DATE_DESC}, 0, 0, ${INTERNAL_BACKEND}, ${INTERNAL_BACKEND}, '', '', '', '')`,
    );
    const addKey = db.prepare(`INSERT INTO auth_token (version, domain, value, use_count, user_id) VALUES (0, 'subsonic', ?, 0, ?)`);
    for (const [account, type] of [
      [admin, USER_TYPE.admin],
      [guest, USER_TYPE.regular],
    ] as const) {
      const { lastInsertRowid } = addUser.run(type, account.username);
      addKey.run(account.password, lastInsertRowid);
    }
    db.exec(`INSERT INTO media_library (version, path, name) VALUES (0, '/music', 'Music')`);
    // One file to copy, without a write-ahead log beside it.
    db.exec("PRAGMA journal_mode = DELETE");
  } finally {
    db.close();
  }
  return readFile(file);
}

export const lms: ServerDefinition = {
  name: "lms",
  image: IMAGE,
  port: 5082,
  musicPath: "/music",
  traits: { reportsLastScan: false, keepsPlaylistComments: false, splitsArtists: true },
  admin,
  guest,
  // LMS runs as its own user, who must be able to write the database copied in as another.
  configure: async (container) => container.withCopyContentToContainer([{ content: await seededDatabase(), target: "/var/lms/lms.db", mode: 0o666 }]),
  setUp: async () => {},
};
