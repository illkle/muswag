# Tests against real servers

muswag is tested against the OpenSubsonic servers people run it with: Navidrome, gonic and LMS. Each
test file declares its tests once per server with `forEachServer`, and each server runs in a Docker
container of a pinned version for the length of the file.

```
pnpm test:integration                                 # every server
MUSWAG_TEST_SERVERS=gonic,lms pnpm test:integration   # some of them
```

Docker is all the tests need. They skip themselves when it is not running.

## What is where

- `test/servers/` starts the servers. `server.ts` has what they share: it copies a library into the
  container, has the server scan it and waits until the server lists exactly that library.
  `navidrome.ts`, `gonic.ts` and `lms.ts` set each one up with an administrator and a second user,
  and say in `traits` what the tests should expect of that server alone.
- `test/library/` has the libraries as fixtures and writes them as tagged MP3 files with covers,
  without ffmpeg.
- `sync.integration.test.ts`, `playlists.integration.test.ts`, `login.integration.test.ts` and
  `api.integration.test.ts` test the library sync, the playlist sync, logging in, and every request
  muswag makes, streaming and covers included.

## What differs between servers

|                                                       | Navidrome              | gonic                                                    | LMS                                                          |
| ----------------------------------------------------- | ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Logs in with                                          | the password           | the password                                             | an API key, made in LMS's settings, in place of the password |
| `getScanStatus` says when it last scanned             | yes                    | no                                                       | no                                                           |
| Keeps a playlist's comment                            | yes                    | yes                                                      | no: it takes none and sends none                             |
| Sends a field it has no value for                     | leaves it out, or `{}` | as `null`                                                | leaves it out                                                |
| Reads every artist of a song with several             | yes                    | only the first, unless `GONIC_MULTI_VALUE_ARTIST` is set | yes                                                          |
| An album's `songCount` after a song's file is deleted | still counts it        | counts the songs left                                    | counts the songs left                                        |

Without the time of the last scan, muswag cannot tell which songs changed, so every sync reads every
song again. With it, a sync reads every song only after a scan, and otherwise only the albums that look
changed.

LMS has no way to make a user or an API key but its web interface, so the tests start an LMS once,
let it make its database, and write both users and their keys into it (`seededDatabase` in `lms.ts`).
The users have no password, so nobody can log in to that LMS's web interface.

## Recorded answers

`MUSWAG_RECORD_RESPONSES=1 pnpm test:integration` writes what each server answered to muswag's
requests to `packages/backend/src/api/recorded/`. A unit test there decodes every answer as the app
does, so a change to the client that one of the servers would not take fails without Docker. Record
again after moving a server to another version.

## Trying the app against a server

```
pnpm --filter @muswag/tests serve gonic
```

starts the server with a library of every fixture and prints its address and two accounts. Log in to
the dev app with them; to look at the app from another machine, run it as `AGENTS.md` describes.
Ctrl-C stops the server.

Before a release, go through this with each server:

1. Log in with a wrong password, then with the right one. On LMS, the account's password should get
   a message that asks for an API key.
2. The first sync ends without a problem, and the counts of albums, artists and songs match the
   server's web interface. LMS has no web interface to log in to; check it with the other two.
3. Covers show for albums that have them. `東京の夜` has none, and shows the placeholder.
4. Search finds `Starálfur` and `ネオン`.
5. Play a song, seek forward and back, and let it go on to the next song without a gap.
6. Make a playlist, add songs, remove one, rename it, give it a comment and delete it, checking each
   step in the server's web interface, or on LMS in the app after a sync. On LMS the comment goes
   away after the next sync.
7. Log out, and log in to another server.
