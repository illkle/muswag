import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe } from "vitest";

import { definitions } from "./definitions.js";
import { type ServerTraits, startServer, type TestServer } from "./server.js";

export type { ServerTraits, TestServer } from "./server.js";
export type { Account } from "./subsonic.js";

/** The servers to test against: all of them, or those `MUSWAG_TEST_SERVERS` names, as in `gonic,lms`. */
const selected = (() => {
  const names = process.env["MUSWAG_TEST_SERVERS"]?.split(",").map((name) => name.trim());
  if (!names) return definitions;
  const unknown = names.filter((name) => !definitions.some((definition) => definition.name === name));
  if (unknown.length > 0) throw new Error(`MUSWAG_TEST_SERVERS names servers there are none of: ${unknown.join(", ")}`);
  return definitions.filter(({ name }) => names.includes(name));
})();

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
if (!dockerAvailable) console.warn("Skipping the server tests: Docker is not available.");

/**
 * Declares `tests` once for every server, in a `describe` named after it. The server starts before
 * its tests and stops after them; `server()` answers with it while they run. `traits` are there while
 * the tests are declared, for a test that is only for some servers.
 */
export function forEachServer(tests: (server: () => TestServer, traits: ServerTraits) => void): void {
  for (const definition of selected) {
    describe.skipIf(!dockerAvailable)(`${definition.name}`, () => {
      let running: TestServer | undefined;
      beforeAll(async () => {
        running = await startServer(definition);
      });
      afterAll(async () => {
        await running?.stop();
      });
      tests(() => {
        if (!running) throw new Error(`${definition.name} did not start`);
        return running;
      }, definition.traits);
    });
  }
}
