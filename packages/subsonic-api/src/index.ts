import { z } from "zod";

const API_VERSION = "1.16.1";
const CLIENT_NAME = "muswag";
const HEX = "0123456789abcdef";

type FetchImplementation = typeof fetch;
type RequestParams = Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;

export interface SubsonicConfig {
  url: string;
  auth:
    | {
        username: string;
        password: string;
        apiKey?: never;
      }
    | {
        username?: never;
        password?: never;
        apiKey: string;
      };
  salt?: string;
  reuseSalt?: boolean;
  post?: boolean;
  fetch?: FetchImplementation;
  crypto?: Crypto;
}

const subsonicErrorSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  helpUrl: z.string().optional(),
});

const baseResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
  openSubsonic: z.boolean().optional(),
  type: z.string().optional(),
  serverVersion: z.string().optional(),
  error: subsonicErrorSchema.optional(),
});

const itemGenreSchema = z.object({
  name: z.string(),
});

const itemDateSchema = z.object({
  year: z.number().optional(),
  month: z.number().optional(),
  day: z.number().optional(),
});

const recordLabelSchema = z.object({
  name: z.string(),
});

const discTitleSchema = z.object({
  disc: z.number(),
  title: z.string(),
});

const artistID3Schema = z.object({
  albumCount: z.number().optional(),
  artistImageUrl: z.string().optional(),
  coverArt: z.string().optional(),
  id: z.string(),
  name: z.string(),
  starred: z.string().optional(),
  musicBrainzId: z.string().optional(),
  sortName: z.string().optional(),
  roles: z.array(z.string()).optional(),
});

const contributorSchema = z.object({
  role: z.string(),
  subRole: z.string().optional(),
  artist: artistID3Schema.optional(),
});

const replayGainSchema = z.object({
  trackGain: z.number().optional(),
  albumGain: z.number().optional(),
  trackPeak: z.number().optional(),
  albumPeak: z.number().optional(),
  baseGain: z.number().optional(),
  fallbackGain: z.number().optional(),
});

const childSchema = z.object({
  album: z.string().optional(),
  albumId: z.string().optional(),
  artist: z.string().optional(),
  artistId: z.string().optional(),
  averageRating: z.number().optional(),
  bitRate: z.number().optional(),
  bookmarkPosition: z.number().optional(),
  contentType: z.string().optional(),
  coverArt: z.string().optional(),
  created: z.string().optional(),
  discNumber: z.number().optional(),
  duration: z.number().optional(),
  genre: z.string().optional(),
  id: z.string(),
  isDir: z.boolean(),
  isVideo: z.boolean().optional(),
  originalHeight: z.number().optional(),
  originalWidth: z.number().optional(),
  parent: z.string().optional(),
  path: z.string().optional(),
  playCount: z.number().optional(),
  size: z.number().optional(),
  starred: z.string().optional(),
  suffix: z.string().optional(),
  title: z.string(),
  track: z.number().optional(),
  transcodedContentType: z.string().optional(),
  transcodedSuffix: z.string().optional(),
  type: z.enum(["music", "podcast", "audiobook", "video"]).optional(),
  userRating: z.number().optional(),
  year: z.number().optional(),
  played: z.string().optional(),
  bpm: z.number().optional(),
  comment: z.string().optional(),
  sortName: z.string().optional(),
  musicBrainzId: z.string().optional(),
  genres: z.array(itemGenreSchema).optional(),
  artists: z.array(artistID3Schema).optional(),
  displayArtist: z.string().optional(),
  albumArtists: z.array(artistID3Schema).optional(),
  displayAlbumArtist: z.string().optional(),
  contributors: z.array(contributorSchema).optional(),
  displayComposer: z.string().optional(),
  moods: z.array(z.string()).optional(),
  replayGain: replayGainSchema.optional(),
  explicitStatus: z.string().optional(),
});

const albumID3Schema = z.object({
  artist: z.string().optional(),
  artistId: z.string().optional(),
  coverArt: z.string().optional(),
  created: z.string(),
  duration: z.number(),
  genre: z.string().optional(),
  id: z.string(),
  name: z.string(),
  playCount: z.number().optional(),
  songCount: z.number(),
  starred: z.string().optional(),
  year: z.number().optional(),
  version: z.string().optional(),
  played: z.string().optional(),
  userRating: z.number().optional(),
  recordLabels: z.array(recordLabelSchema).optional(),
  musicBrainzId: z.string().optional(),
  genres: z.array(itemGenreSchema).optional(),
  artists: z.array(artistID3Schema).optional(),
  displayArtist: z.string().optional(),
  releaseTypes: z.array(z.string()).optional(),
  moods: z.array(z.string()).optional(),
  sortName: z.string().optional(),
  originalReleaseDate: itemDateSchema.optional(),
  releaseDate: itemDateSchema.optional(),
  isCompilation: z.boolean().optional(),
  explicitStatus: z.string().optional(),
  discTitles: z.array(discTitleSchema).optional(),
});

const albumWithSongsID3Schema = albumID3Schema.extend({
  song: z.array(childSchema).optional(),
});

const albumList2Schema = z.object({
  album: z.array(albumID3Schema).optional(),
});

const playlistSchema = z.object({
  id: z.string(),
  name: z.string(),
  comment: z.string().optional(),
  owner: z.string().optional(),
  public: z.boolean().optional(),
  songCount: z.number(),
  duration: z.number(),
  created: z.string(),
  changed: z.string(),
  coverArt: z.string().optional(),
  allowedUser: z.array(z.string()).optional(),
  readonly: z.boolean().optional(),
  validUntil: z.string().optional(),
});

const playlistWithSongsSchema = playlistSchema.extend({
  entry: z.array(childSchema).optional(),
});

const playlistsSchema = z.object({
  playlist: z.array(playlistSchema).optional(),
});

const pingResponseSchema = z.object({});
const getAlbumResponseSchema = z.object({
  album: albumWithSongsID3Schema,
});
const getAlbumList2ResponseSchema = z.object({
  albumList2: albumList2Schema,
});
const getPlaylistsResponseSchema = z.object({
  playlists: playlistsSchema,
});
const getPlaylistResponseSchema = z.object({
  playlist: playlistWithSongsSchema,
});
const createPlaylistResponseSchema = z.object({
  playlist: playlistWithSongsSchema,
});

const responseEnvelopeSchema = z.object({
  "subsonic-response": z.unknown(),
});

export type SubsonicBaseResponse = z.infer<typeof baseResponseSchema>;
export type SubsonicError = z.infer<typeof subsonicErrorSchema>;
export type ItemGenre = z.infer<typeof itemGenreSchema>;
export type ItemDate = z.infer<typeof itemDateSchema>;
export type RecordLabel = z.infer<typeof recordLabelSchema>;
export type DiscTitle = z.infer<typeof discTitleSchema>;
export type ArtistID3 = z.infer<typeof artistID3Schema>;
export type Contributor = z.infer<typeof contributorSchema>;
export type ReplayGain = z.infer<typeof replayGainSchema>;
export type MediaType = "music" | "podcast" | "audiobook" | "video";
export type Child = z.infer<typeof childSchema>;
export type AlbumID3 = z.infer<typeof albumID3Schema>;
export type AlbumWithSongsID3 = z.infer<typeof albumWithSongsID3Schema>;
export type AlbumList2 = z.infer<typeof albumList2Schema>;
export type Playlist = z.infer<typeof playlistSchema>;
export type PlaylistWithSongs = z.infer<typeof playlistWithSongsSchema>;
export type Playlists = z.infer<typeof playlistsSchema>;

export type GetAlbumList2Args = {
  type: "alphabeticalByName" | "alphabeticalByArtist" | "byYear" | "random" | "newest" | "highest" | "frequent" | "recent";
  size?: number;
  offset?: number;
  fromYear?: number;
  toYear?: number;
  genre?: string;
  musicFolderId?: string | number;
};

export type GetAlbumArgs = {
  id: string;
};

export type GetCoverArtArgs = {
  id: string;
  size?: number;
};

export type GetPlaylistArgs = {
  id: string;
};

export type CreatePlaylistArgs = {
  playlistId?: string;
  name?: string;
  songId?: string[];
};

export type UpdatePlaylistArgs = {
  playlistId: string;
  name?: string;
  comment?: string;
  public?: boolean;
  songIdToAdd?: string[];
  songIndexToRemove?: number[];
};

export type DeletePlaylistArgs = {
  id: string;
};

export class SubsonicApiError extends Error {
  readonly code: number | undefined;
  readonly helpUrl: string | undefined;

  constructor(message: string, error?: SubsonicError) {
    super(message);
    this.name = "SubsonicApiError";
    this.code = error?.code;
    this.helpUrl = error?.helpUrl;
  }
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function add32(...values: number[]): number {
  return values.reduce((sum, value) => (sum + value) >>> 0, 0);
}

function md5(input: string): string {
  const message = new TextEncoder().encode(input);
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4,
    11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;

      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const next = d;
      d = c;
      c = b;
      b = add32(b, rotateLeft(add32(a, f, constants[index] ?? 0, view.getUint32(offset + g * 4, true)), shifts[index] ?? 0));
      a = next;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  return [a0, b0, c0, d0]
    .map((word) => {
      let output = "";
      for (let index = 0; index < 4; index += 1) {
        const byte = (word >>> (index * 8)) & 0xff;
        output += HEX[byte >>> 4] ?? "0";
        output += HEX[byte & 0x0f] ?? "0";
      }
      return output;
    })
    .join("");
}

function base64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "~").replace(/\//g, "_").replace(/=/g, "");
}

async function loadCrypto(): Promise<Crypto> {
  if (globalThis.crypto) {
    return globalThis.crypto;
  }

  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.webcrypto as Crypto;
}

export default class SubsonicAPI {
  readonly #config: SubsonicConfig;
  readonly #fetch: FetchImplementation;
  #crypto: Crypto | undefined;

  constructor(config: SubsonicConfig) {
    if (!config) {
      throw new Error("no config provided");
    }
    if (!config.url) {
      throw new Error("no url provided");
    }
    if (!config.auth) {
      throw new Error("no auth provided");
    }
    if (!config.auth.apiKey) {
      if (!config.auth.username) {
        throw new Error("no username provided");
      }
      if (!config.auth.password) {
        throw new Error("no password provided");
      }
    }

    const fetchImplementation = config.fetch ?? globalThis.fetch;
    if (!fetchImplementation) {
      throw new Error("no fetch implementation available");
    }

    this.#config = config;
    this.#crypto = config.crypto ?? globalThis.crypto;
    this.#fetch = fetchImplementation.bind(globalThis);
  }

  baseURL(): string {
    let url = this.#config.url;
    if (!url.startsWith("http")) {
      url = `https://${url}`;
    }
    if (!url.endsWith("/")) {
      url += "/";
    }
    return url;
  }

  async ping(): Promise<SubsonicBaseResponse> {
    return this.#json("ping", {}, pingResponseSchema);
  }

  async getAlbum(args: GetAlbumArgs): Promise<SubsonicBaseResponse & { album: AlbumWithSongsID3 }> {
    return this.#json("getAlbum", args, getAlbumResponseSchema);
  }

  async getAlbumList2(args: GetAlbumList2Args): Promise<SubsonicBaseResponse & { albumList2: AlbumList2 }> {
    return this.#json("getAlbumList2", args, getAlbumList2ResponseSchema);
  }

  async getCoverArt(args: GetCoverArtArgs): Promise<Response> {
    return this.#request("getCoverArt", args);
  }

  async getPlaylists(): Promise<SubsonicBaseResponse & { playlists: Playlists }> {
    return this.#json("getPlaylists", {}, getPlaylistsResponseSchema);
  }

  async getPlaylist(args: GetPlaylistArgs): Promise<SubsonicBaseResponse & { playlist: PlaylistWithSongs }> {
    return this.#json("getPlaylist", args, getPlaylistResponseSchema);
  }

  async createPlaylist(args: CreatePlaylistArgs): Promise<SubsonicBaseResponse & { playlist: PlaylistWithSongs }> {
    return this.#json("createPlaylist", args, createPlaylistResponseSchema);
  }

  async updatePlaylist(args: UpdatePlaylistArgs): Promise<SubsonicBaseResponse> {
    return this.#json("updatePlaylist", args, pingResponseSchema);
  }

  async deletePlaylist(args: DeletePlaylistArgs): Promise<SubsonicBaseResponse> {
    return this.#json("deletePlaylist", args, pingResponseSchema);
  }

  async #json<T extends z.AnyZodObject>(
    method: string,
    params: RequestParams,
    payloadSchema: T,
  ): Promise<SubsonicBaseResponse & z.output<T>> {
    const response = await this.#request(method, params);
    if (!response.ok) {
      throw new Error(`${method} failed: HTTP ${response.status}`);
    }

    const payload: unknown = await response.json();
    const envelope = responseEnvelopeSchema.parse(payload);
    const subsonicResponse = baseResponseSchema.parse(envelope["subsonic-response"]);

    if (subsonicResponse.status !== "ok") {
      const message = subsonicResponse.error?.message ?? `${method} failed: Subsonic status ${subsonicResponse.status}`;
      throw new SubsonicApiError(message, subsonicResponse.error);
    }

    const responseSchema = baseResponseSchema.merge(payloadSchema);
    return responseSchema.parse(envelope["subsonic-response"]) as SubsonicBaseResponse & z.output<T>;
  }

  async #request(method: string, params: RequestParams): Promise<Response> {
    const url = await this.#requestUrl(method, params);

    if (this.#config.post) {
      const [requestUrl, body] = url.toString().split("?");
      return this.#fetch(requestUrl ?? url.toString(), {
        method: "POST",
        body: body ?? "",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    }

    return this.#fetch(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
  }

  async #requestUrl(method: string, params: RequestParams): Promise<URL> {
    let restUrl = this.baseURL();
    if (!restUrl.endsWith("rest/")) {
      restUrl += "rest/";
    }

    const url = new URL(`${method}.view`, restUrl);
    url.searchParams.set("v", API_VERSION);
    url.searchParams.set("c", CLIENT_NAME);
    url.searchParams.set("f", "json");

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, item.toString());
        }
      } else {
        url.searchParams.set(key, value.toString());
      }
    }

    if (this.#config.auth.apiKey) {
      url.searchParams.set("apiKey", this.#config.auth.apiKey);
      return url;
    }

    const { username, password } = this.#config.auth;
    if (!username || !password) {
      throw new Error("no auth provided");
    }

    url.searchParams.set("u", username);
    const { salt, token } = await this.#token(password);
    url.searchParams.set("t", token);
    url.searchParams.set("s", salt);
    return url;
  }

  async #token(password: string): Promise<{ salt: string; token: string }> {
    let salt = this.#config.salt;
    if (!salt || !this.#config.reuseSalt) {
      salt = await this.#randomSalt();
    }

    if (this.#config.reuseSalt) {
      this.#config.salt = salt;
    }

    return {
      salt,
      token: md5(password + salt),
    };
  }

  async #randomSalt(): Promise<string> {
    this.#crypto ??= await loadCrypto();
    const bytes = this.#crypto.getRandomValues(new Uint8Array(16));
    return base64Url(bytes);
  }
}
