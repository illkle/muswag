import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import type { AlbumFixture, SongFixture } from "./fixtures.js";

/**
 * Writes `albums` into `root` as tagged MP3 files, `<album artist>/<album>/<disc>-<track>.mp3`, with
 * a `cover.png` beside the songs of an album that has a cover. A song's path does not depend on its
 * title, so a fixture that retitles a song retags the same file. Every file is given `modified` as
 * the time it was last changed.
 */
export async function writeLibrary(root: string, albums: readonly AlbumFixture[], modified: Date): Promise<void> {
  const write = async (file: string, data: Buffer) => {
    await writeFile(file, data);
    await utimes(file, modified, modified);
  };
  for (const album of albums) {
    const dir = albumDirectory(root, album);
    await mkdir(dir, { recursive: true });
    if (album.cover !== false) await write(path.join(dir, "cover.png"), solidPng(album.title));
    for (const song of album.songs) {
      await write(path.join(dir, `${song.disc ?? 1}-${String(song.track).padStart(2, "0")}.mp3`), Buffer.concat([id3Tag(album, song), silence(song.durationSec)]));
    }
  }
}

function albumDirectory(root: string, album: AlbumFixture): string {
  const safe = (name: string) => name.replace(/[/\\:*?"<>|]/g, "_");
  return path.join(root, safe(album.albumArtist), safe(album.title));
}

// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, mono, no CRC. A frame with zeroed side information
// carries no audio data, which every decoder plays as silence.
const FRAME_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0xc4]);
const FRAME_BYTES = Math.floor((144 * 128_000) / 44_100);
const SAMPLES_PER_FRAME = 1152;

/** An MP3 stream of silence that lasts `seconds`, made of constant bitrate frames. */
function silence(seconds: number): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  FRAME_HEADER.copy(frame);
  const frames = Math.max(1, Math.round((seconds * 44_100) / SAMPLES_PER_FRAME));
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

const synchsafe = (value: number) => Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);

function frame(id: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id, "latin1"), synchsafe(payload.length), Buffer.from([0, 0]), payload]);
}

/** A UTF-8 text frame. ID3v2.4 separates the values of a frame that has several with a null byte. */
function text(id: string, ...values: string[]): Buffer {
  return frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(values.join("\0"), "utf8")]));
}

function userText(description: string, value: string): Buffer {
  return frame("TXXX", Buffer.concat([Buffer.from([3]), Buffer.from(`${description}\0${value}`, "utf8")]));
}

function id3Tag(album: AlbumFixture, song: SongFixture): Buffer {
  const artists = song.artists ?? [album.albumArtist];
  const discs = Math.max(...album.songs.map(({ disc }) => disc ?? 1));
  const frames = [
    text("TIT2", song.title),
    text("TPE1", ...artists),
    text("TALB", album.title),
    text("TPE2", album.albumArtist),
    text("TRCK", `${song.track}/${album.songs.filter(({ disc }) => (disc ?? 1) === (song.disc ?? 1)).length}`),
    text("TPOS", `${song.disc ?? 1}/${discs}`),
    text("TDRC", String(album.year)),
    text("TCON", album.genre),
  ];
  if (album.compilation) frames.push(text("TCMP", "1"));
  if (album.musicBrainzId) frames.push(userText("MusicBrainz Album Id", album.musicBrainzId));
  if (song.musicBrainzId) frames.push(frame("UFID", Buffer.from(`http://musicbrainz.org\0${song.musicBrainzId}`, "latin1")));
  if (song.replayGain) {
    frames.push(userText("REPLAYGAIN_TRACK_GAIN", `${song.replayGain.track.toFixed(2)} dB`), userText("REPLAYGAIN_ALBUM_GAIN", `${song.replayGain.album.toFixed(2)} dB`));
  }
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, 0]), synchsafe(body.length), body]);
}

/** A small PNG of one colour, which `seed` picks, so that albums have covers that differ. */
function solidPng(seed: string): Buffer {
  const size = 32;
  const hue = crc32(seed);
  const rgb = [hue & 0xff, (hue >> 8) & 0xff, (hue >> 16) & 0xff];
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
