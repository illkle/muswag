/** Shown when mpv omits the playlist entry IDs the player correlates lifecycle events with. */
export const MPV_ENTRY_ID_UNSUPPORTED = "The installed mpv did not provide a valid playlist entry ID. Muswag requires mpv 0.33.0 or newer.";

/** Thrown when no usable mpv binary is configured. */
export class MpvUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpvUnavailableError";
  }
}

/** Thrown when a previously resolved mpv binary can no longer be spawned. */
export class MpvBinaryMissingError extends Error {
  readonly binaryPath: string;

  constructor(binaryPath: string) {
    super(`The mpv binary at ${binaryPath} could not be started.`);
    this.name = "MpvBinaryMissingError";
    this.binaryPath = binaryPath;
  }
}

export function isMpvResolutionError(cause: unknown): boolean {
  return cause instanceof MpvUnavailableError || cause instanceof MpvBinaryMissingError;
}
