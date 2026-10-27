import { Schema } from "effect";

/** Minutes in each unit the sync setting is given in. */
export const SYNC_AFTER_UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60, weeks: 7 * 24 * 60 } as const;
export const SyncAfterUnit = Schema.Literals(["minutes", "hours", "days", "weeks"]);
export type SyncAfterUnit = typeof SyncAfterUnit.Type;

/** Main checks every 5 minutes whether a sync is due, so less would not sync any sooner. */
const MIN_MINUTES = 5;
const MAX_MINUTES = 365 * 24 * 60;

/** How old the last library sync may get before the app syncs again: from 5 minutes to a year, in whole units. */
export const SyncAfter = Schema.Struct({ amount: Schema.Int, unit: SyncAfterUnit }).check(
  Schema.makeFilter(({ amount, unit }) => {
    const minutes = amount * SYNC_AFTER_UNIT_MINUTES[unit];
    return minutes >= MIN_MINUTES && minutes <= MAX_MINUTES;
  }),
);
export type SyncAfter = typeof SyncAfter.Type;

/** The whole amounts of `unit` that `SyncAfter` takes. */
export const syncAfterLimits = (unit: SyncAfterUnit) => ({
  min: Math.ceil(MIN_MINUTES / SYNC_AFTER_UNIT_MINUTES[unit]),
  max: Math.floor(MAX_MINUTES / SYNC_AFTER_UNIT_MINUTES[unit]),
});

/** When the app syncs the library on its own: as it opens, and while it is open, once the last sync is older than `syncAfter`. */
export const SyncSettings = Schema.Struct({ syncAfter: SyncAfter });
export type SyncSettings = typeof SyncSettings.Type;

export const DEFAULT_SYNC_SETTINGS: SyncSettings = { syncAfter: { amount: 1, unit: "weeks" } };

/** `syncAfter` in milliseconds. */
export const syncAfterMs = ({ amount, unit }: SyncAfter): number => amount * SYNC_AFTER_UNIT_MINUTES[unit] * 60_000;
