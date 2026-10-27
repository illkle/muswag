import { ArrowsClockwiseIcon, CheckCircleIcon, DownloadSimpleIcon, InfoIcon, PackageIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRef } from "react";

import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { formatAgo } from "#/lib/format";
import { cn } from "#/lib/utils";
import { Disclosure } from "#/components/ui-custom/disclosure";
import { RadioTabItem, RadioTabs } from "#/components/ui-custom/radio-tabs";
import { getAppUpdateStatus, isAppUpdateBusy, AppUpdateIPC, shortVersion } from "#/updates/app-update";
import { channelOfVersion, type AppUpdateState, type AppUpdateStatus, type UpdateChannel } from "#shared/state/app-update";

/** What the update work is doing, with the version it concerns where there is one. */
function statusLine(state: AppUpdateState | null, status: AppUpdateStatus): string {
  const latest = state?.latestVersion ? shortVersion(state.latestVersion) : null;
  switch (status) {
    case "disabled":
      return "Updates are off in development builds";
    case "idle":
      return "Not checked yet";
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return state?.lastCheckedAt ? `Up to date, checked ${formatAgo(state.lastCheckedAt)}` : "Up to date";
    case "downloading":
      return `Downloading ${latest ?? "the update"}${state?.progressPercent === null || state?.progressPercent === undefined ? "…" : `, ${Math.round(state.progressPercent)}%`}`;
    case "ready":
      return latest ? `Ready to install ${latest}` : "Ready to install";
    case "error":
      // A check and a download fail alike, and the state does not say which it was.
      return "Update failed";
  }
}

/** Spins only where nothing else shows work going on: a check spins its button, a download fills its bar. */
function StatusIcon({ status, percent }: { status: AppUpdateStatus; percent: number | null }) {
  if (status === "downloading") return percent === null ? <SpinnerGapIcon className="mt-px size-3.5 shrink-0 animate-spin" /> : <DownloadSimpleIcon className="mt-px size-3.5 shrink-0" />;
  if (status === "up-to-date") return <CheckCircleIcon className="mt-px size-3.5 shrink-0 text-brand" weight="fill" />;
  if (status === "ready") return <PackageIcon className="mt-px size-3.5 shrink-0 text-brand" />;
  if (status === "error") return <WarningCircleIcon className="mt-px size-3.5 shrink-0" weight="fill" />;
  return <InfoIcon className="mt-px size-3.5 shrink-0" />;
}

const channelOptions: { label: string; value: UpdateChannel }[] = [
  { label: "Stable", value: "stable" },
  { label: "Nightly", value: "nightly" },
];

/** What choosing `channel` means for an install of `version`. */
function channelNote(channel: UpdateChannel, version: string): string {
  if (channel === "nightly") return "Daily builds, may have bugs";
  // Main never goes back to an older version, so a nightly install waits for the next stable release.
  if (channelOfVersion(version) === "nightly") return "This nightly stays until a stable release is newer";
  return "Stable releases only";
}

export function AppUpdateDialog({ onOpenChange, open, state }: { onOpenChange: (open: boolean) => void; open: boolean; state: AppUpdateState | null }) {
  const status = getAppUpdateStatus(state);
  const busy = isAppUpdateBusy(status);
  const percent = state?.progressPercent ?? null;
  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Focus starts on the dialog itself, so opening it with the pointer does not ring the channel control. */}
      <DialogContent ref={popupRef} initialFocus={popupRef} placement="top">
        <DialogHeader>
          <DialogTitle>Updates</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm [overflow-wrap:anywhere]">
                  muswag{" "}
                  <span title={state ? `v${state.currentVersion}` : undefined} className="tabular-nums">
                    {state ? shortVersion(state.currentVersion) : "v…"}
                  </span>
                </div>
                <div aria-live="polite" className={cn("flex gap-1.5 text-xs", status === "error" ? "text-destructive" : "text-muted-foreground")}>
                  <StatusIcon status={status} percent={percent} />
                  <span className="[overflow-wrap:anywhere]">{statusLine(state, status)}</span>
                </div>
              </div>
              {status === "ready" ? (
                <Button size="sm" className="shrink-0" onClick={() => void AppUpdateIPC.install()}>
                  Restart and install
                </Button>
              ) : state?.canCheck ? (
                // A development build cannot check, so it gets no dead button. A download keeps it, disabled, as a check does.
                <Button size="sm" variant="outline" className="shrink-0" disabled={busy} onClick={() => void AppUpdateIPC.check()}>
                  {status === "checking" ? <SpinnerGapIcon className="animate-spin" /> : <ArrowsClockwiseIcon />}
                  {status === "error" ? "Try again" : "Check now"}
                </Button>
              ) : null}
            </div>

            {/* What the updater said, which can run long: under the row, so its button stays put, and behind a
                disclosure that keys and copying reach. */}
            {status === "error" && state?.error ? (
              <Disclosure label="Show details" openLabel="Hide details">
                <p className="whitespace-pre-wrap">{state.error}</p>
              </Disclosure>
            ) : null}

            {status === "downloading" && percent !== null ? (
              <div role="progressbar" aria-label="Update download" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} className="h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
              </div>
            ) : null}
          </div>

          {state ? (
            <div className="flex items-center justify-between gap-4 border-t pt-4">
              <div className="min-w-0">
                <span id="update-channel-label" className="block text-sm">
                  Update channel
                </span>
                <p className="text-xs text-pretty text-muted-foreground">{state.canCheck ? channelNote(state.channel, state.currentVersion) : "Takes effect in packaged builds"}</p>
              </div>
              <RadioTabs
                aria-labelledby="update-channel-label"
                className="h-8 shrink-0 rounded-md p-0.5"
                onValueChange={(value) => void AppUpdateIPC.setChannel(value as UpdateChannel)}
                value={state.channel}
              >
                {channelOptions.map(({ label, value }) => (
                  <RadioTabItem key={value} value={value} className="font-normal">
                    {label}
                  </RadioTabItem>
                ))}
              </RadioTabs>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
