import { largeLibrary, librarySetA, librarySetB, longSongs, variedLibrary } from "../library/fixtures.js";
import { definitions } from "./definitions.js";
import { startServer } from "./server.js";

/**
 * Runs the server named `name` with a library of every fixture until Ctrl-C, for trying the app
 * against it by hand: `pnpm --filter @muswag/tests serve gonic`.
 */
export async function serve(name: string | undefined): Promise<void> {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) {
    console.error(`Name a server to start: ${definitions.map(({ name }) => name).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.info(`Starting ${definition.name} (${definition.image})…`);
  const server = await startServer(definition);
  await server.setLibrary([longSongs, ...variedLibrary, ...librarySetA, ...librarySetB, ...largeLibrary(40, 3)]);
  console.info(
    [
      `${server.name} is serving at ${server.url}`,
      `  administrator: ${server.admin.username} / ${server.admin.password}`,
      `  user:          ${server.guest.username} / ${server.guest.password}`,
      "Press Ctrl-C to stop it.",
    ].join("\n"),
  );

  // Nothing else keeps the process up while it waits.
  const alive = setInterval(() => {}, 60_000);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearInterval(alive);
  await server.stop();
}
