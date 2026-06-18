import type { PlayQueueInput, PlayerEvent, PlayerState } from "./player";
import type { UserCredentialsToLogin } from "@muswag/shared";

export type MuswagMainIpc = {
  "coverArt:removeFiles": (albumId: string) => void;
  "coverArt:writeFile": (albumId: string, extension: string, bytes: Uint8Array) => string;
  "player:getState": () => PlayerState;
  "player:next": () => void;
  "player:pause": () => void;
  "player:play": () => void;
  "player:playQueue": (input: PlayQueueInput) => void;
  "player:previous": () => void;
  "player:seek": (positionSeconds: number) => void;
  "player:setCredentials": (credentials: UserCredentialsToLogin | null) => void;
  "player:toggle": () => void;
};

export type MuswagRendererIpc = {
  "player:event": [event: PlayerEvent];
};
