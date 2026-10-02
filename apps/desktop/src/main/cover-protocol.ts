import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import { resolveInside } from "./app/platform";

const SCHEME = "muswag-cover";

/** Must run before the app is ready. */
export function registerCoverScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** Serves cached cover files, which are relative to `userDataPath` and may not leave it. */
export function handleCoverProtocol(userDataPath: string): void {
  protocol.handle(SCHEME, (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath) {
      return new Response("Missing path", { status: 400 });
    }

    let absolutePath: string;
    try {
      absolutePath = resolveInside(userDataPath, requestedPath);
    } catch {
      return new Response("Invalid path", { status: 400 });
    }

    return net.fetch(pathToFileURL(absolutePath).toString());
  });
}
