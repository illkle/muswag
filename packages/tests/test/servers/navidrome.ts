import type { ServerDefinition } from "./server.js";

const admin = { username: "admin", password: "adminpass" };
const guest = { username: "guest", password: "guestpass" };

async function post(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { "x-nd-authorization": `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

async function expectOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status} ${await response.text()}`);
  return response;
}

export const navidrome: ServerDefinition = {
  name: "navidrome",
  image: "deluan/navidrome:0.64.2",
  port: 4533,
  musicPath: "/music",
  traits: { reportsLastScan: true, keepsPlaylistComments: true, splitsArtists: true },
  admin,
  guest,
  configure: async (container) =>
    container.withEnvironment({
      ND_MUSICFOLDER: "/music",
      ND_DATAFOLDER: "/data",
      ND_SCANNER_SCANONSTARTUP: "false",
      // The tests start every scan; one at start-up or from a watcher would run in the middle of one.
      ND_SCANNER_SCHEDULE: "0",
      ND_SCANNER_WATCHERWAIT: "0",
      ND_ENABLEINSIGHTSCOLLECTOR: "false",
      ND_LOGLEVEL: "warn",
    }),
  setUp: async (url) => {
    // The first user, made while there is none, is the administrator.
    await expectOk(await post(`${url}/auth/createAdmin`, admin), "Creating the administrator");
    const { token } = (await (await expectOk(await post(`${url}/auth/login`, admin), "Logging in")).json()) as { token: string };
    await expectOk(await post(`${url}/api/user`, { userName: guest.username, name: "Guest", password: guest.password, isAdmin: false }, token), "Creating the guest");
  },
  startScanParams: { fullScan: true },
};
