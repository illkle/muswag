import { Player, type PlayerOptions } from "./player";

export function createPlayer(options: PlayerOptions): Player {
  return new Player(options);
}

export { Player } from "./player";
export type { PlayerOptions } from "./player";
export { getDefaultMpvIpcPath } from "./mpv/ipc-path";
