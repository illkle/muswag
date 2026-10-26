import { ArrowsClockwiseIcon, CaretDownIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useId, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { InputGroup, InputGroupInput } from "#/components/ui/input-group";
import { LibraryActions } from "#/library/actions";
import { syncPercent, useLibrarySyncStatus, useSyncSettings } from "#/library/queries";
import { getErrorMessage } from "#/lib/err";
import { formatAgo } from "#/lib/format";
import { SYNC_AFTER_UNIT_MINUTES, SyncAfter, type SyncAfterUnit } from "#shared/state/sync-settings";

const isSyncAfter = Schema.is(SyncAfter);

const units: ReadonlyArray<{ readonly value: SyncAfterUnit; readonly one: string; readonly many: string }> = [
  { value: "minutes", one: "minute", many: "minutes" },
  { value: "hours", one: "hour", many: "hours" },
  { value: "days", one: "day", many: "days" },
  { value: "weeks", one: "week", many: "weeks" },
];

const amountOf = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));

/** `text`, an amount of `from`, as the nearest whole amount of `to`, and at least one; left as it is when it is not a number. */
const convert = (text: string, from: SyncAfterUnit, to: SyncAfterUnit) => {
  const amount = amountOf(text);
  if (!Number.isFinite(amount)) return text;
  return String(Math.max(1, Math.round((amount * SYNC_AFTER_UNIT_MINUTES[from]) / SYNC_AFTER_UNIT_MINUTES[to])));
};

/** How long after the last sync the app syncs again, saved as soon as it is one the app takes. */
function SyncAfterField() {
  const { syncAfter } = useSyncSettings();
  const [draft, setDraft] = useState(String(syncAfter.amount));
  const [unit, setUnit] = useState<SyncAfterUnit>(syncAfter.unit);
  const [saveError, setSaveError] = useState<string | null>(null);
  // What was last asked to be saved, rather than what main has saved: a value changed and changed back
  // before the first save is through must be saved again. Main saves them in the order asked.
  const requested = useRef(syncAfter);
  const id = useId();

  const amount = amountOf(draft);
  const valid = isSyncAfter({ amount, unit });

  const change = (nextDraft: string, nextUnit: SyncAfterUnit) => {
    setDraft(nextDraft);
    setUnit(nextUnit);
    const next = { amount: amountOf(nextDraft), unit: nextUnit };
    if (!isSyncAfter(next) || (next.amount === requested.current.amount && next.unit === requested.current.unit)) return;
    requested.current = next;
    setSaveError(null);
    LibraryActions.setSyncSettings({ syncAfter: next }).catch((error: unknown) => setSaveError(getErrorMessage(error, "The setting could not be saved.")));
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-sm">
          Auto sync after
        </label>
        <InputGroup className="w-44 overflow-hidden has-[select:focus-visible]:border-ring has-[select:focus-visible]:ring-3 has-[select:focus-visible]:ring-ring/50">
          <InputGroupInput
            id={id}
            type="number"
            min={1}
            step={1}
            value={draft}
            onChange={(event) => change(event.target.value, unit)}
            aria-invalid={!valid}
            // Without the arrows Chromium draws to step the value.
            className="[appearance:textfield] text-right tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <div className="relative flex h-full shrink-0 items-center border-l border-input bg-muted">
            <select
              aria-label="Unit"
              value={unit}
              onChange={(event) => {
                const next = event.target.value as SyncAfterUnit;
                change(convert(draft, unit, next), next);
              }}
              className="h-full cursor-default appearance-none bg-transparent pr-7 pl-2.5 text-sm text-muted-foreground outline-none"
            >
              {units.map(({ value, one, many }) => (
                <option key={value} value={value}>
                  {amount === 1 ? one : many}
                </option>
              ))}
            </select>
            <CaretDownIcon className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
          </div>
        </InputGroup>
      </div>
      {!valid ? <p className="text-xs text-destructive">Enter a whole number, from 5 minutes to a year.</p> : null}
      {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}
    </div>
  );
}

/** When the library last synced, and a sync started from here or anywhere else as it runs. */
function LastSync() {
  const status = useLibrarySyncStatus();
  const sync = useMutation({ mutationFn: () => LibraryActions.sync() });
  const running = sync.isPending || status.running;
  const percent = syncPercent(status);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span>
          <span className="text-muted-foreground">Last sync: </span>
          {running ? `syncing…${percent === null ? "" : ` ${percent}%`}` : status.lastSyncedAt ? formatAgo(status.lastSyncedAt) : "never"}
        </span>
        <Button size="sm" variant="secondary" disabled={running} onClick={() => sync.mutate()}>
          {running ? <SpinnerGapIcon className="animate-spin" /> : <ArrowsClockwiseIcon />}
          Sync now
        </Button>
      </div>
      {status.error && !running ? <p className="text-xs text-destructive">{status.error}</p> : null}
    </div>
  );
}

/** Whether the server says when it last scanned its files, which decides how much a sync downloads. */
function ServerScans() {
  const lastScan = useQuery({ queryKey: ["library", "lastScan"], queryFn: () => LibraryActions.lastScan(), staleTime: 0, retry: false });
  const name = <code className="font-mono text-foreground">lastScan</code>;

  if (lastScan.isPending) return <p className="text-xs text-muted-foreground">Asking the server what it reports…</p>;
  if (lastScan.isError) return <p className="text-xs text-destructive">The server could not be asked: {getErrorMessage(lastScan.error, "it did not answer.")}</p>;
  return lastScan.data ? (
    <p className="text-xs text-muted-foreground">Your server reports {name}, which lets muswag download only what changed. Syncs after the first are fast and light.</p>
  ) : (
    <p className="text-xs text-muted-foreground">Your server does not report {name}, so muswag cannot tell what changed. Every sync downloads the full list of songs again.</p>
  );
}

export function SyncSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Library sync</DialogTitle>
        </DialogHeader>
        {/* Mounted with the dialog, so the field starts from the saved setting and the server is asked again each time it opens. */}
        {open ? (
          <div className="space-y-4">
            <LastSync />
            <div className="space-y-4 border-t pt-4">
              <SyncAfterField />
              <ServerScans />
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
