import { memoryTable } from "@muswag/tanstack-db-mirror/memory";
import { Schema } from "effect";

/**
 * The state of the app's own updates as renderers see it: a one-row memory table in the state mirror,
 * which main writes as a check or a download goes on.
 */

export const AppUpdateStatus = Schema.Literals(["disabled", "idle", "checking", "up-to-date", "downloading", "ready", "error"]);
export type AppUpdateStatus = typeof AppUpdateStatus.Type;

export const AppUpdateState = Schema.Struct({
  canCheck: Schema.Boolean,
  currentVersion: Schema.String,
  error: Schema.NullOr(Schema.String),
  latestVersion: Schema.NullOr(Schema.String),
  lastCheckedAt: Schema.NullOr(Schema.String),
  progressPercent: Schema.NullOr(Schema.Finite),
  status: AppUpdateStatus,
});
export type AppUpdateState = typeof AppUpdateState.Type;

export const appUpdate = memoryTable("app_update", Schema.Struct({ id: Schema.Literal("app_update"), value: AppUpdateState }), { primaryKey: "id" });
