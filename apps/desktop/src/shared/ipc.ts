import type { PlayQueueInput, PlayerEvent, PlayerState } from "./player";
import type { UserCredentialsToLogin } from "@muswag/shared";

export type AppUpdateStatus = "disabled" | "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error";

export type AppUpdateState = {
  canCheck: boolean;
  currentVersion: string;
  error: string | null;
  latestVersion: string | null;
  lastCheckedAt: string | null;
  progressPercent: number | null;
  status: AppUpdateStatus;
};

export type MuswagMainIpc = {
  "appUpdate:check": () => AppUpdateState;
  "appUpdate:getState": () => AppUpdateState;
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
  "player:setMuted": (muted: boolean) => void;
  "player:setVolume": (volumePercent: number) => void;
  "player:toggle": () => void;
};

export type MuswagRendererIpc = {
  "appUpdate:state": [state: AppUpdateState];
  "player:event": [event: PlayerEvent];
};
