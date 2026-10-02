import { ArrowsClockwiseIcon, CheckCircleIcon, DownloadSimpleIcon, FolderOpenIcon, SpinnerGapIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { usePlayerError, usePlayerInstallOutput, usePlayerMpvBinary, usePlayerMpvInstall, usePlayerStatus } from "#/player/hooks";
import { MpvIPC } from "#/player/commands";
import type { BinaryState, MpvInstallOption, MpvSource } from "#shared/commands/player";
import type { PlayerStatus } from "#shared/state/player";

const playerStatusLabels: Record<PlayerStatus, string> = {
  idle: "Idle",
  loading: "Loading",
  playing: "Playing",
  paused: "Paused",
  ended: "Ended",
  error: "Error",
};

const mpvSourceLabels: Record<MpvSource, string> = {
  env: "MUSWAG_MPV_PATH",
  manual: "Chosen by you",
  cache: "Remembered from last launch",
  path: "Found on PATH",
  "well-known": "Found in a standard install location",
  "login-shell": "Found via your shell profile",
};

export const mpvStatusLabels: Record<BinaryState["_tag"], string> = {
  Checking: "Checking",
  Ready: "Available",
  Unavailable: "Unavailable",
};

function MpvStatusIcon({ status }: { status: BinaryState["_tag"] }) {
  if (status === "Ready") {
    return <CheckCircleIcon className="size-4 text-emerald-500" />;
  }
  if (status === "Checking") {
    return <SpinnerGapIcon className="size-4 animate-spin" />;
  }
  return <XCircleIcon className="size-4" />;
}

function InstallOptionRow({ busy, onInstall, option }: { busy: boolean; onInstall: (option: MpvInstallOption) => void; option: MpvInstallOption }) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <code className="min-w-0 truncate font-mono text-xs">{option.command}</code>
        {option.automatic ? (
          <Button disabled={busy} onClick={() => onInstall(option)} size="sm">
            <DownloadSimpleIcon />
            Install
          </Button>
        ) : (
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(option.command);
            }}
            size="sm"
            variant="outline"
          >
            Copy
          </Button>
        )}
      </div>
      {option.note ? (
        <p className="text-xs text-muted-foreground">
          {option.note}
          {option.url ? (
            <>
              {" "}
              <a className="underline underline-offset-2" href={option.url} rel="noreferrer" target="_blank">
                {option.url}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function MpvInfoDialog({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const binary = usePlayerMpvBinary();
  const install = usePlayerMpvInstall();
  const playerError = usePlayerError();
  const playerStatus = usePlayerStatus();
  const installLog = usePlayerInstallOutput().slice(-100);
  const [busy, setBusy] = useState(false);
  const autoOpenedRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Playback is impossible without mpv, so surface setup as soon as the startup check fails.
  useEffect(() => {
    if (autoOpenedRef.current || binary._tag !== "Unavailable") {
      return;
    }

    autoOpenedRef.current = true;
    onOpenChange(true);
  }, [binary._tag, onOpenChange]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [installLog.length]);

  const installing = install._tag === "Running" || install._tag === "Cancelling";
  const installOptions = binary._tag === "Unavailable" ? binary.options : [];

  const runInstall = (option: MpvInstallOption) => {
    setBusy(true);
    void MpvIPC.install(option.method)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const recheck = () => {
    setBusy(true);
    void MpvIPC.recheck()
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const locate = () => {
    setBusy(true);
    void MpvIPC.locate()
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Playback engine</DialogTitle>
          <DialogDescription>Muswag plays audio through the mpv binary installed on this machine.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <MpvStatusIcon status={binary._tag} />
              <span className="font-medium">mpv</span>
            </div>
            <Badge variant={binary._tag === "Ready" ? "secondary" : "destructive"}>{mpvStatusLabels[binary._tag]}</Badge>
          </div>

          {binary._tag === "Ready" ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono">{binary.version}</dd>
              <dt className="text-muted-foreground">Binary</dt>
              <dd className="font-mono text-xs break-all">{binary.path}</dd>
              <dt className="text-muted-foreground">Found by</dt>
              <dd>{mpvSourceLabels[binary.source]}</dd>
            </dl>
          ) : null}

          {binary._tag === "Unavailable" ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <div className="flex items-center gap-2 font-medium">
                <WarningCircleIcon className="size-4" />
                mpv cannot be used
              </div>
              <p className="mt-2 break-words text-destructive/90">{binary.issue.message}</p>
            </div>
          ) : null}

          {installOptions.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm font-medium">Install mpv</div>
              {installOptions.map((option) => (
                <InstallOptionRow busy={busy || installing} key={option.method} onInstall={runInstall} option={option} />
              ))}
            </div>
          ) : null}

          {install._tag === "Cancelled" ? <p className="text-sm text-muted-foreground">Installation cancelled.</p> : null}
          {install._tag === "Failed" ? <p className="text-sm break-words text-destructive">{install.issue.message}</p> : null}

          {installLog.length > 0 ? (
            <div className="max-h-48 overflow-auto rounded-lg border bg-muted/40 p-2">
              <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{installLog.join("\n")}</pre>
              <div ref={logEndRef} />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || installing} onClick={recheck} size="sm" variant="outline">
              <ArrowsClockwiseIcon className={busy && !installing ? "animate-spin" : undefined} />
              Re-check
            </Button>
            <Button disabled={busy || installing} onClick={locate} size="sm" variant="outline">
              <FolderOpenIcon />
              Locate mpv…
            </Button>
            {binary._tag === "Ready" && binary.source === "manual" ? (
              <Button
                disabled={busy || installing}
                onClick={() => {
                  setBusy(true);
                  void MpvIPC.clearManualPath()
                    .catch(() => {})
                    .finally(() => setBusy(false));
                }}
                size="sm"
                variant="ghost"
              >
                Reset to automatic
              </Button>
            ) : null}
            {installing ? (
              <Button
                onClick={() => {
                  void MpvIPC.cancelInstall().catch(() => {});
                }}
                size="sm"
                variant="ghost"
              >
                Cancel install
              </Button>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-4 border-t pt-3 text-sm">
            <span className="text-muted-foreground">Playback status</span>
            <span className="font-medium">{playerStatusLabels[playerStatus]}</span>
          </div>

          {playerError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <div className="flex items-center gap-2 font-medium">
                <WarningCircleIcon className="size-4" />
                Last playback error
              </div>
              <p className="mt-2 break-words text-destructive/90">{playerError}</p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircleIcon className="size-4 text-emerald-500" />
              No errors reported.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
