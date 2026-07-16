import { AlertTriangle, CheckCircle2, Download, PackageCheck, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { SidebarMenuButton } from "#/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";
import { AppUpdateIPC } from "#/lib/ipc";
import type { AppUpdateState, AppUpdateStatus } from "#shared/ipc";

const statusLabels: Record<AppUpdateStatus, string> = {
  disabled: "Updates unavailable in development",
  idle: "Ready to check",
  checking: "Checking GitHub Releases…",
  "up-to-date": "You’re up to date",
  downloading: "Downloading update…",
  ready: "Update ready to install",
  error: "Update check failed",
};

function StatusIcon({ status }: { status: AppUpdateStatus }) {
  if (status === "checking") {
    return <RefreshCw className="size-3.5 animate-spin" />;
  }
  if (status === "downloading") {
    return <Download className="size-3.5" />;
  }
  if (status === "ready") {
    return <PackageCheck className="size-3.5" />;
  }
  if (status === "error") {
    return <AlertTriangle className="size-3.5" />;
  }
  return <CheckCircle2 className="size-3.5" />;
}

function formatLastChecked(value: string | null): string {
  if (!value) {
    return "Not checked yet";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function AppVersionButton() {
  const [state, setState] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = AppUpdateIPC.subscribe(setState);

    void AppUpdateIPC.getState().then((nextState) => {
      if (active) {
        setState(nextState);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const status = state?.status ?? "idle";
  const busy = status === "checking" || status === "downloading";
  const version = state?.currentVersion ?? "…";

  const checkForUpdates = () => {
    if (!state?.canCheck || busy) {
      return;
    }
    void AppUpdateIPC.check().then(setState);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            aria-label={`Muswag version ${version}. Check for updates`}
            aria-busy={busy}
            className="text-sidebar-foreground/70"
            onClick={checkForUpdates}
            size="sm"
          >
            <RefreshCw className={busy ? "animate-spin" : undefined} />
            <span className="font-mono tabular-nums">v{version}</span>
          </SidebarMenuButton>
        }
      />
      <TooltipContent align="end" className="block w-72 max-w-72 space-y-3 px-3 py-3 text-left" side="right" sideOffset={8}>
        <div>
          <div className="text-sm font-semibold">Muswag v{version}</div>
          <div className="mt-1 flex items-center gap-1.5 text-background/75">
            <StatusIcon status={status} />
            <span>{statusLabels[status]}</span>
            {status === "downloading" && state?.progressPercent !== null ? <span>{state?.progressPercent}%</span> : null}
          </div>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-y border-background/15 py-2 text-background/75">
          <dt>Installed</dt>
          <dd className="text-right font-mono text-background">v{version}</dd>
          {state?.latestVersion ? (
            <>
              <dt>Latest</dt>
              <dd className="text-right font-mono text-background">v{state.latestVersion}</dd>
            </>
          ) : null}
          <dt>Last checked</dt>
          <dd className="text-right text-background">{formatLastChecked(state?.lastCheckedAt ?? null)}</dd>
        </dl>

        {state?.error ? <p className="break-words text-red-300">{state.error}</p> : null}
        <p className="text-background/70">
          {state?.canCheck ? "Click the version button to check GitHub Releases now." : "Update checks are enabled in packaged builds."}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
