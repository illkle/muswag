export class SubsonicRequestError extends Error {
  public readonly url: string;
  public readonly status: number;
  public readonly details: string;

  constructor(url: string, status: number, details: string) {
    super(`Subsonic request failed (${status}) for ${url}: ${details}`);
    this.name = "SubsonicRequestError";
    this.url = url;
    this.status = status;
    this.details = details;
  }
}

export class SubsonicFailureError extends Error {
  public readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(`Subsonic API returned failure: ${message}`);
    this.name = "SubsonicFailureError";
    this.code = code;
  }
}
