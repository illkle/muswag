import { Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BinariesLive } from "./binary/binaries";
import { InstallerLive } from "./binary/installer";
import { MpvConnectionLive } from "./mpv/connection";
import { MpvSessionLive } from "./mpv/session";
import { PlayerLive } from "./player";
import { SettingsLive } from "./settings";
export const makePlayerLayer = (options: { ipcPath: string; settingsPath: string; extraMpvArgs?: readonly string[] }) => {
  const binaries = BinariesLive;
  return PlayerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        binaries,
        InstallerLive.pipe(Layer.provide(binaries)),
        MpvSessionLive(options.ipcPath).pipe(Layer.provide(MpvConnectionLive(options.extraMpvArgs))),
        SettingsLive(options.settingsPath),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
};
