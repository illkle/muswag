import { Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BinariesLive } from "./binary/binaries";
import { MpvConnectionLive } from "./mpv/connection";
import { MpvSessionLive } from "./mpv/session";
import { PlayerLive } from "./player";
import { SettingsLive } from "./settings";
import { AppState, type AppStateHub } from "../app-state";

/** The player publishes its state to renderers through `appState`. */
export const makePlayerLayer = (options: { ipcPath: string; settingsPath: string; appState: AppStateHub }) =>
  PlayerLive.pipe(
    Layer.provide([Layer.succeed(AppState, options.appState), MpvSessionLive(options.ipcPath).pipe(Layer.provide(MpvConnectionLive())), SettingsLive(options.settingsPath)]),
    Layer.provide(BinariesLive),
    Layer.provide(NodeServices.layer),
  );
