import type { PlayerSnapshot } from "#shared/player-contract";
import type { MpvInstallState, MpvState, PlayerRuntimeState } from "#shared/player";

export function runtimeView(snapshot: PlayerSnapshot): PlayerRuntimeState {
  const playback = snapshot.playback;
  const media = playback._tag === "Idle" ? null : playback.media;
  return {
    sequence: snapshot.stamp.revision,
    epoch: snapshot.stamp.epoch,
    current: media?.item ?? null,
    status: playback._tag === "Recovering" ? "loading" : playback._tag === "Failed" ? "error" : (playback._tag.toLowerCase() as PlayerRuntimeState["status"]),
    positionSeconds: media?.positionSeconds ?? 0,
    durationSeconds: media?.durationSeconds ?? null,
    paused: playback._tag === "Paused" || (playback._tag === "Loading" && playback.targetPaused),
    error: playback._tag === "Failed" ? playback.issue.message : (snapshot.issues.at(-1)?.message ?? null),
    volumePercent: snapshot.audio.volumePercent,
    muted: snapshot.audio.muted,
  };
}
export function binaryView(snapshot: PlayerSnapshot): MpvState {
  const binary = snapshot.binary;
  if (binary._tag === "Checking") return { status: "checking" };
  if (binary._tag === "Ready") return { status: "ready", binaryPath: binary.path, version: binary.version, source: binary.source };
  return { status: "missing", checkedPaths: [], installOptions: [...binary.options], reason: binary.issue.message };
}
export function installView(snapshot: PlayerSnapshot): MpvInstallState {
  const install = snapshot.install;
  if (install._tag === "Idle") return { status: "idle" };
  if (install._tag === "Failed") return { status: "failed", method: install.method, error: install.issue.message };
  if (install._tag === "Cancelled") return { status: "cancelled", method: install.method };
  if (install._tag === "Succeeded") return { status: "succeeded", method: install.method };
  return { status: "running", method: install.method };
}

/** A subscription establishes the epoch. Delayed replies cannot replace newer state. */
export function acceptSnapshot(current: PlayerSnapshot, incoming: PlayerSnapshot, epoch: string): PlayerSnapshot {
  return incoming.stamp.epoch === epoch && (current.stamp.epoch !== epoch || incoming.stamp.revision > current.stamp.revision) ? incoming : current;
}
