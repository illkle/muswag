export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface PlayerQueueItem {
  id: string;
  title: string;
  albumId: string | null;
  album: string | null;
  artist: string | null;
  displayArtist: string | null;
  duration: number | null;
  discNumber: number | null;
  track: number | null;
}

export interface PlayQueueInput {
  queue: PlayerQueueItem[];
  startIndex: number;
}

export interface PlayerState {
  status: PlayerStatus;
  queue: string[];
  currentIndex: number;
  currentTrackId: string | null;
  canPlay: boolean;
  canGoForward: boolean;
  canGoBack: boolean;
  canSeek: boolean;
  positionSeconds: number;
  durationSeconds: number | null;
  error: string | null;
  mpvAvailable: boolean;
}

export type PlayerEvent = {
  type: "state";
  state: PlayerState;
};

export function createDefaultPlayerState(): PlayerState {
  return {
    status: "idle",
    queue: [],
    currentIndex: -1,
    currentTrackId: null,
    canPlay: false,
    canGoForward: false,
    canGoBack: false,
    canSeek: false,
    positionSeconds: 0,
    durationSeconds: null,
    error: null,
    mpvAvailable: true,
  };
}
