import type { ServerDefinition } from "./server.js";

/** gonic makes this administrator on its first start. */
const admin = { username: "admin", password: "admin" };
const guest = { username: "guest", password: "guestpass" };

/** Posts a form of gonic's web interface, which answers by redirecting with what it did in the session. */
async function postForm(url: string, form: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie && { cookie }) },
    body: new URLSearchParams(form),
  });
}

export const gonic: ServerDefinition = {
  name: "gonic",
  image: "sentriz/gonic:v0.22.0",
  port: 80,
  musicPath: "/music",
  traits: { reportsLastScan: false, keepsPlaylistComments: true, splitsArtists: false },
  admin,
  guest,
  // gonic will not start without a playlists folder, which its image does not make.
  configure: async (container) => container.withTmpFs({ "/playlists": "rw" }),
  setUp: async (url) => {
    const login = await postForm(`${url}/admin/login_do`, admin);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    if (!cookie) throw new Error(`Logging in to gonic's web interface failed: HTTP ${login.status}`);
    const created = await postForm(`${url}/admin/create_user_do`, { username: guest.username, password_one: guest.password, password_two: guest.password }, cookie);
    if (created.status >= 400) throw new Error(`Creating the guest failed: HTTP ${created.status} ${await created.text()}`);
  },
};
