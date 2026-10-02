import type { BinaryState, InstallState, PlayerSnapshot } from "#shared/player-contract";
import type { MpvInstallState, MpvState, PlayerRuntimeState } from "#shared/player";

/** The snapshot as main's queue manager follows it. */
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
    buffering: playback._tag === "Playing" && playback.buffering,
    error: playback._tag === "Failed" ? playback.issue.message : (snapshot.issues.at(-1)?.message ?? null),
    volumePercent: snapshot.audio.volumePercent,
    muted: snapshot.audio.muted,
  };
}
export function binaryView(binary: BinaryState): MpvState {
  if (binary._tag === "Checking") return { status: "checking" };
  if (binary._tag === "Ready") return { status: "ready", binaryPath: binary.path, version: binary.version, source: binary.source };
  return { status: "missing", checkedPaths: [], installOptions: [...binary.options], reason: binary.issue.message };
}
export function installView(install: InstallState): MpvInstallState {
  if (install._tag === "Idle") return { status: "idle" };
  if (install._tag === "Failed") return { status: "failed", method: install.method, error: install.issue.message };
  if (install._tag === "Cancelled") return { status: "cancelled", method: install.method };
  if (install._tag === "Succeeded") return { status: "succeeded", method: install.method };
  return { status: "running", method: install.method };
}
