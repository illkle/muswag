import { createHash, randomBytes } from "node:crypto";

import type { NavidromeConnection } from "../public-api.js";

const DEFAULT_PROTOCOL_VERSION = "1.16.1";

export function createSubsonicSalt(byteLength = 8): string {
  return randomBytes(byteLength).toString("hex");
}

export function createSubsonicToken(password: string, salt: string): string {
  return createHash("md5").update(`${password}${salt}`, "utf8").digest("hex");
}

export function buildAuthQueryParams(
  connection: NavidromeConnection,
  salt = createSubsonicSalt()
): URLSearchParams {
  const params = new URLSearchParams();
  const protocolVersion = connection.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

  params.set("u", connection.username);
  params.set("t", createSubsonicToken(connection.password, salt));
  params.set("s", salt);
  params.set("v", protocolVersion);
  params.set("c", connection.clientName);
  params.set("f", "json");

  return params;
}

export function buildAuthenticatedUrl(
  connection: NavidromeConnection,
  endpoint: string,
  additionalParams: Record<string, string>,
  salt = createSubsonicSalt()
): URL {
  const normalizedBase = connection.baseUrl.endsWith("/")
    ? connection.baseUrl
    : `${connection.baseUrl}/`;
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");

  const url = new URL(normalizedEndpoint, normalizedBase);
  const authParams = buildAuthQueryParams(connection, salt);

  for (const [key, value] of Object.entries(additionalParams)) {
    authParams.set(key, value);
  }

  url.search = authParams.toString();
  return url;
}
