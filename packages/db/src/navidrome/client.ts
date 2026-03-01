import type { GetAlbumList2Response } from "@muswag/opensubsonic-types";

import { SubsonicFailureError, SubsonicRequestError } from "../errors.js";
import type { NavidromeConnection } from "../public-api.js";
import { buildAuthenticatedUrl } from "./auth.js";

export type AlbumPayload = Record<string, unknown>;

export interface FetchAlbumList2PageOptions {
  connection: NavidromeConnection;
  offset: number;
  size: number;
  fetchImpl?: typeof fetch;
}

export interface FetchAlbumList2PageResult {
  albums: AlbumPayload[];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toAlbums(value: unknown): AlbumPayload[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is AlbumPayload => !!asObject(item));
  }

  const one = asObject(value);
  return one ? [one] : [];
}

async function readFailureBody(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.slice(0, 500);
  } catch {
    return "failed to read response body";
  }
}

export async function fetchAlbumList2Page({
  connection,
  offset,
  size,
  fetchImpl = fetch,
}: FetchAlbumList2PageOptions): Promise<FetchAlbumList2PageResult> {
  const url = buildAuthenticatedUrl(connection, "rest/getAlbumList2", {
    type: "alphabeticalByName",
    size: String(size),
    offset: String(offset),
  });

  const response = await fetchImpl(url);

  if (!response.ok) {
    throw new SubsonicRequestError(
      url.toString(),
      response.status,
      await readFailureBody(response),
    );
  }

  const payload = (await response.json()) as GetAlbumList2Response;
  const payloadRecord = asObject(payload);
  const envelope = asObject(payloadRecord?.["subsonic-response"]);

  if (!envelope) {
    throw new SubsonicRequestError(
      url.toString(),
      response.status,
      "Missing subsonic-response envelope",
    );
  }

  if (envelope.status === "failed") {
    const error = asObject(envelope.error);
    const message = typeof error?.message === "string" ? error.message : "Unknown failure";
    const code = typeof error?.code === "number" ? error.code : null;
    throw new SubsonicFailureError(message, code);
  }

  if (envelope.status !== "ok") {
    throw new SubsonicRequestError(
      url.toString(),
      response.status,
      `Unexpected Subsonic status: ${String(envelope.status)}`,
    );
  }

  const albumList2 = asObject(envelope.albumList2);
  return {
    albums: toAlbums(albumList2?.album),
  };
}
