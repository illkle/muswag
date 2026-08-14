import { join } from "node:path";

export function getDefaultMpvIpcPath(baseDirectory: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\muswag-mpv-${process.pid}`;
  }
  return join(baseDirectory, `muswag-mpv-${process.pid}.sock`);
}
