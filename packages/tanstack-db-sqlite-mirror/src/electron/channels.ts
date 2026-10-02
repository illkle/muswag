export const DEFAULT_MIRROR_CHANNEL = "tanstack-db-sqlite-mirror";

export const mirrorChannels = (channel: string) => ({
  request: `${channel}:request`,
  changes: `${channel}:changes`,
});
