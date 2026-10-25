import { memoryTable } from "@muswag/tanstack-db-mirror/memory";
import { Schema } from "effect";

/**
 * The state of the app's own updates as renderers see it: a one-row memory table in the state mirror,
 * which main writes as a check or a download goes on.
 */

export const AppUpdateStatus = Schema.Literals(["disabled", "idle", "checking", "up-to-date", "downloading", "ready", "error"]);
export type AppUpdateStatus = typeof AppUpdateStatus.Type;

/**
 * The releases the app updates from: the stable ones, from release tags, or the nightly builds of master.
 * The release workflow (`.github/workflows/release.yml`) makes both.
 */
export const UpdateChannel = Schema.Literals(["stable", "nightly"]);
export type UpdateChannel = typeof UpdateChannel.Type;

/** The channel a version was released on, which is the one an install starts on. */
export const channelOfVersion = (version: string): UpdateChannel => (version.includes("-nightly.") ? "nightly" : "stable");

export const AppUpdateState = Schema.Struct({
  canCheck: Schema.Boolean,
  channel: UpdateChannel,
  currentVersion: Schema.String,
  error: Schema.NullOr(Schema.String),
  latestVersion: Schema.NullOr(Schema.String),
  lastCheckedAt: Schema.NullOr(Schema.String),
  progressPercent: Schema.NullOr(Schema.Finite),
  status: AppUpdateStatus,
});
export type AppUpdateState = typeof AppUpdateState.Type;

export const appUpdate = memoryTable("app_update", Schema.Struct({ id: Schema.Literal("app_update"), value: AppUpdateState }), { primaryKey: "id" });
