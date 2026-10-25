import { MemoryMirror, type MemoryMirrorService } from "@muswag/tanstack-db-mirror/server/memory";
import { Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BinariesLive } from "./binary/binaries";
import { MpvConnectionLive } from "./mpv/connection";
import { MpvSessionLive } from "./mpv/session";
import { PlayerLive } from "./player";
import { SettingsLive } from "./settings";

/** `stateMirror` serves the player's state to renderers; it must mirror `PLAYER_TABLES`. */
export const makePlayerLayer = (options: { ipcPath: string; settingsPath: string; stateMirror: MemoryMirrorService }) =>
  PlayerLive.pipe(
    Layer.provide([Layer.succeed(MemoryMirror, options.stateMirror), MpvSessionLive(options.ipcPath).pipe(Layer.provide(MpvConnectionLive())), SettingsLive(options.settingsPath)]),
    Layer.provide(BinariesLive),
    Layer.provide(NodeServices.layer),
  );
