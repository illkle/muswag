/** Thrown when no usable mpv binary is known, so playback cannot even be attempted. */
export class MpvUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpvUnavailableError";
  }
}

/** Thrown when a previously resolved mpv binary has disappeared (for example after a package manager upgrade). */
export class MpvBinaryMissingError extends Error {
  readonly binaryPath: string;

  constructor(binaryPath: string) {
    super(`The mpv binary at ${binaryPath} could not be started.`);
    this.name = "MpvBinaryMissingError";
    this.binaryPath = binaryPath;
  }
}

/** True when the error means the resolved mpv path has to be looked up again. */
export function isMpvResolutionError(cause: unknown): boolean {
  return cause instanceof MpvUnavailableError || cause instanceof MpvBinaryMissingError;
}
