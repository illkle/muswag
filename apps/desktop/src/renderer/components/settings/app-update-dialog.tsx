import { AlertTriangle, CheckCircle2, Download, PackageCheck, RefreshCw } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { getAppUpdateStatus, isAppUpdateBusy } from "#/hooks/use-app-update";
import { AppUpdateIPC } from "#/lib/ipc";
import type { AppUpdateState, AppUpdateStatus } from "#shared/ipc";

const statusLabels: Record<AppUpdateStatus, string> = {
  disabled: "Updates are only checked in packaged builds",
  idle: "Ready to check",
  checking: "Checking GitHub Releases…",
  "up-to-date": "You’re on the latest version",
  downloading: "Downloading the update…",
  ready: "Update downloaded, restart to install",
  error: "The update check failed",
};

function StatusIcon({ status }: { status: AppUpdateStatus }) {
  if (status === "checking") {
    return <RefreshCw className="size-4 animate-spin" />;
  }
  if (status === "downloading") {
    return <Download className="size-4" />;
  }
  if (status === "ready") {
    return <PackageCheck className="size-4 text-emerald-500" />;
  }
  if (status === "error") {
    return <AlertTriangle className="size-4 text-destructive" />;
  }
  return <CheckCircle2 className="size-4 text-emerald-500" />;
}

function formatLastChecked(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AppUpdateDialog({
  onOpenChange,
  open,
  state,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  state: AppUpdateState | null;
}) {
  const status = getAppUpdateStatus(state);
  const busy = isAppUpdateBusy(status);
  const version = state?.currentVersion ?? "…";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Muswag v{version}</DialogTitle>
          <DialogDescription>Updates are published as GitHub Releases and download in the background.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <StatusIcon status={status} />
            <span>{statusLabels[status]}</span>
          </div>

          {status === "downloading" && state?.progressPercent !== null ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${state?.progressPercent ?? 0}%` }}
              />
            </div>
          ) : null}

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t pt-4 text-xs">
            <dt className="text-muted-foreground">Installed</dt>
            <dd className="text-right font-mono tabular-nums">v{version}</dd>
            {state?.latestVersion ? (
              <>
                <dt className="text-muted-foreground">Latest</dt>
                <dd className="text-right font-mono tabular-nums">v{state.latestVersion}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Last checked</dt>
            <dd className="text-right">{formatLastChecked(state?.lastCheckedAt ?? null)}</dd>
          </dl>

          {state?.error ? <p className="rounded-md bg-destructive/10 p-3 text-xs break-words text-destructive">{state.error}</p> : null}
        </div>

        <DialogFooter className="sm:justify-start">
          {status === "ready" ? (
            <Button onClick={() => void AppUpdateIPC.install()}>
              <PackageCheck />
              Restart and install
            </Button>
          ) : null}
          <Button
            disabled={!state?.canCheck || busy}
            onClick={() => void AppUpdateIPC.check()}
            variant={status === "ready" ? "secondary" : "default"}
          >
            <RefreshCw className={busy ? "animate-spin" : undefined} />
            Check for updates
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
