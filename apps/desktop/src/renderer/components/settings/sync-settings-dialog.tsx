import { ArrowsClockwiseIcon, CaretUpDownIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useId, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { InputGroup, InputGroupInput } from "#/components/ui/input-group";
import { InlineError } from "#/components/ui-custom/inline-error";
import { LibraryActions } from "#/library/actions";
import { syncPercent, useLibrarySyncStatus, useSyncSettings } from "#/library/queries";
import { getErrorMessage } from "#/lib/err";
import { formatAgo } from "#/lib/format";
import { SYNC_AFTER_UNIT_MINUTES, SyncAfter, syncAfterLimits, type SyncAfterUnit } from "#shared/state/sync-settings";

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
  const limits = syncAfterLimits(unit);

  const change = (nextDraft: string, nextUnit: SyncAfterUnit) => {
    setDraft(nextDraft);
    setUnit(nextUnit);
    const next = { amount: amountOf(nextDraft), unit: nextUnit };
    if (!isSyncAfter(next) || (next.amount === requested.current.amount && next.unit === requested.current.unit)) return;
    const previous = requested.current;
    requested.current = next;
    setSaveError(null);
    LibraryActions.setSyncSettings({ syncAfter: next }).catch((error: unknown) => {
      // Not saved, so asking for the same value again has to try again.
      if (requested.current === next) requested.current = previous;
      setSaveError(getErrorMessage(error, "The setting could not be saved"));
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={id} className="block text-sm">
            Sync automatically every
          </label>
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            Counted from the last sync
          </p>
        </div>
        <InputGroup className="h-8 w-auto shrink-0 overflow-hidden has-[select:focus-visible]:border-ring has-[select:focus-visible]:ring-3 has-[select:focus-visible]:ring-ring/50">
          <InputGroupInput
            id={id}
            type="number"
            min={limits.min}
            max={limits.max}
            step={1}
            value={draft}
            onChange={(event) => change(event.target.value, unit)}
            aria-invalid={!valid}
            aria-describedby={valid ? `${id}-hint` : `${id}-hint ${id}-error`}
            // Without the arrows Chromium draws to step the value.
            className="w-14 flex-none [appearance:textfield] px-1.5 text-center tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <div className="relative flex h-full shrink-0 items-center border-l border-input">
            <select
              aria-label="Unit"
              value={unit}
              onChange={(event) => {
                const next = event.target.value as SyncAfterUnit;
                change(convert(draft, unit, next), next);
              }}
              className="h-full cursor-default appearance-none bg-transparent pr-7 pl-2.5 text-sm outline-none"
            >
              {units.map(({ value, one, many }) => (
                <option key={value} value={value}>
                  {amount === 1 ? one : many}
                </option>
              ))}
            </select>
            <CaretUpDownIcon className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
          </div>
        </InputGroup>
      </div>
      {!valid ? (
        <InlineError id={`${id}-error`}>
          Enter a whole number of {units.find(({ value }) => value === unit)?.many} from {limits.min} to {limits.max}
        </InlineError>
      ) : null}
      {saveError ? <InlineError>{saveError}</InlineError> : null}
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
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          {/* A fixed name over a status that changes, as the updates dialog has. */}
          <div className="text-sm">Library</div>
          <div aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
            {running ? (percent === null ? "Syncing…" : `Syncing, ${percent}%`) : status.lastSyncedAt ? `Synced ${formatAgo(status.lastSyncedAt)}` : "Never synced"}
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={running} onClick={() => sync.mutate()}>
          {running ? <SpinnerGapIcon className="animate-spin" /> : <ArrowsClockwiseIcon />}
          Sync now
        </Button>
      </div>
      {running && percent !== null ? (
        <div role="progressbar" aria-label="Library sync" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {status.error && !running ? <InlineError>Last sync failed: {status.error}</InlineError> : null}
    </div>
  );
}

/** A line when the server does not say when it last scanned its files, which makes every sync read every song. */
function ServerScans() {
  const lastScan = useQuery({ queryKey: ["library", "lastScan"], queryFn: () => LibraryActions.lastScan(), staleTime: 0, retry: false });
  // Nothing while it asks: most servers report changes, and a line that comes and goes would shift the dialog.
  if (lastScan.isPending) return null;
  if (lastScan.isError) return <InlineError>Could not reach the server: {getErrorMessage(lastScan.error, "it did not answer")}</InlineError>;
  // Fetching only what changed is what a sync should do, so only a server that prevents it is worth a line.
  return lastScan.data ? null : <p className="pr-28 text-xs text-pretty text-muted-foreground">This server cannot report changes, so every sync reads the whole library</p>;
}

export function SyncSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Focus starts on the dialog itself, so a key pressed right after opening it does not start a sync. */}
      <DialogContent ref={popupRef} initialFocus={popupRef} placement="top" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Library sync</DialogTitle>
        </DialogHeader>
        {/* Mounted with the dialog, so the field starts from the saved setting and the server is asked again each time it opens. */}
        {open ? (
          <div className="space-y-4">
            {/* What the server reports decides what a sync fetches, so it is told beside the sync. */}
            <div className="space-y-2.5">
              <LastSync />
              <ServerScans />
            </div>
            <div className="border-t pt-4">
              <SyncAfterField />
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
