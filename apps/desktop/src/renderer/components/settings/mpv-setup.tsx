import { ArrowsClockwiseIcon, CheckCircleIcon, CopyIcon, DownloadSimpleIcon, FolderOpenIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "#/components/ui/button";
import { MpvIPC } from "#/player/commands";
import { usePlayerInstallOutput, usePlayerMpvBinary, usePlayerMpvInstall } from "#/player/hooks";
import { cn } from "#/lib/utils";
import type { MpvInstallMethod, MpvInstallOption, MpvSource } from "#shared/commands/player";

const mpvSourceLabels: Record<MpvSource, string> = {
  env: "MUSWAG_MPV_PATH",
  manual: "Chosen by you",
  cache: "Remembered from last launch",
  path: "Found on PATH",
  "well-known": "Found in a standard install location",
  "login-shell": "Found on PATH as a new terminal sees it",
};

const managerNames: Record<MpvInstallMethod, string> = {
  brew: "Homebrew",
  winget: "WinGet",
  scoop: "Scoop",
  choco: "Chocolatey",
  apt: "APT",
  dnf: "DNF",
  pacman: "pacman",
  zypper: "zypper",
};

/** Long commands wrap at their spaces, and only mid-word when a word is wider than the box, so nothing scrolls sideways. */
const commandClass = "font-mono text-xs leading-relaxed [overflow-wrap:anywhere]";

function StatusPanel({ icon, title, children, tone }: { icon: ReactNode; title: ReactNode; children?: ReactNode; tone: "neutral" | "ready" | "warning" }) {
  return (
    <div
      className={cn(
        "flex min-w-0 gap-3 rounded-lg border p-3.5",
        tone === "ready" && "border-brand/30 bg-brand/5",
        tone === "warning" && "border-amber-500/30 bg-amber-500/5",
        tone === "neutral" && "bg-muted/40",
      )}
    >
      <div className={cn("mt-0.5 shrink-0", tone === "ready" && "text-brand", tone === "warning" && "text-amber-600 dark:text-amber-400", tone === "neutral" && "text-muted-foreground")}>{icon}</div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-medium">{title}</div>
        {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <Button
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      size="sm"
      variant="outline"
    >
      {copied ? <CheckCircleIcon /> : <CopyIcon />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function InstallOptionCard({ disabled, option }: { disabled: boolean; option: MpvInstallOption }) {
  return (
    <div className="min-w-0 space-y-2.5 rounded-lg border p-3.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium">Install with {managerNames[option.method]}</div>
          <p className="text-xs text-muted-foreground">
            {option.automatic ? "Muswag runs this command for you." : (option.note ?? "Run this command in a terminal, then check again.")}
            {option.url ? (
              <>
                {" "}
                <a className="[overflow-wrap:anywhere] underline underline-offset-2" href={option.url} rel="noreferrer" target="_blank">
                  {option.url}
                </a>
              </>
            ) : null}
          </p>
        </div>
        {option.automatic ? (
          <Button disabled={disabled} onClick={() => void MpvIPC.install(option.method).catch(() => {})} size="sm">
            <DownloadSimpleIcon />
            Install
          </Button>
        ) : (
          <CopyButton text={option.command} />
        )}
      </div>
      <code className={cn("block rounded-md bg-muted px-2.5 py-2", commandClass)}>{option.command}</code>
    </div>
  );
}

function InstallLog({ lines }: { lines: readonly string[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [lines.length]);
  return (
    <div className="scrollbar scrollbar-slim scrollbar-flush max-h-40 overflow-y-auto rounded-md border bg-muted/40 p-2.5">
      <pre className="font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">{lines.join("\n")}</pre>
      <div ref={endRef} />
    </div>
  );
}

/**
 * Finding, installing and choosing mpv: what the setup page and the playback engine dialog both show.
 * Main does the work; this shows its state and passes the user's choices on.
 */
export function MpvSetup() {
  const binary = usePlayerMpvBinary();
  const install = usePlayerMpvInstall();
  const installLog = usePlayerInstallOutput();
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const installing = install._tag === "Running" || install._tag === "Cancelling";
  const locked = busy || installing;
  const run = (command: () => Promise<unknown>) => {
    setBusy(true);
    void command()
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const installOptions = binary._tag === "Unavailable" ? binary.options : [];

  return (
    <div className="min-w-0 space-y-4">
      {binary._tag === "Checking" ? (
        <StatusPanel icon={<SpinnerGapIcon className="size-5 animate-spin" />} title="Looking for mpv on this computer…" tone="neutral" />
      ) : binary._tag === "Ready" ? (
        <StatusPanel icon={<CheckCircleIcon weight="fill" className="size-5" />} title={`mpv ${binary.version} is ready`} tone="ready">
          <div className={commandClass}>{binary.path}</div>
          <div className="text-xs">{mpvSourceLabels[binary.source]}</div>
        </StatusPanel>
      ) : installing ? (
        <StatusPanel
          icon={<SpinnerGapIcon className="size-5 animate-spin" />}
          title={install._tag === "Cancelling" ? "Cancelling…" : `Installing mpv with ${managerNames[install.method]}…`}
          tone="neutral"
        >
          This can take a minute or two. Muswag picks mpv up as soon as it is installed.
        </StatusPanel>
      ) : (
        <StatusPanel icon={<WarningCircleIcon weight="fill" className="size-5" />} title="mpv is not set up yet" tone="warning">
          <span className="[overflow-wrap:anywhere]">{binary.message}</span>
        </StatusPanel>
      )}

      {install._tag === "Failed" ? <p className="text-sm [overflow-wrap:anywhere] text-destructive">{install.message}</p> : null}
      {install._tag === "Cancelled" ? <p className="text-sm text-muted-foreground">Installation cancelled.</p> : null}

      {installing || (install._tag === "Failed" && installLog.length > 0) || (showLog && installLog.length > 0) ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Installer output</span>
            {installing ? (
              <Button disabled={install._tag === "Cancelling"} onClick={() => void MpvIPC.cancelInstall().catch(() => {})} size="xs" variant="ghost">
                Cancel install
              </Button>
            ) : null}
          </div>
          {installLog.length > 0 ? <InstallLog lines={installLog} /> : <p className="text-xs text-muted-foreground">Starting…</p>}
        </div>
      ) : null}

      {installOptions.length > 0 && !installing ? (
        <div className="space-y-2">
          {installOptions.map((option) => (
            <InstallOptionCard disabled={locked} key={option.method} option={option} />
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={locked} onClick={() => run(() => MpvIPC.recheck())} size="sm" variant="outline">
          <ArrowsClockwiseIcon className={busy && !installing ? "animate-spin" : undefined} />
          Check again
        </Button>
        <Button disabled={locked} onClick={() => run(() => MpvIPC.locate())} size="sm" variant="outline">
          <FolderOpenIcon />
          Locate mpv…
        </Button>
        {binary._tag === "Ready" && binary.source === "manual" ? (
          <Button disabled={locked} onClick={() => run(() => MpvIPC.clearManualPath())} size="sm" variant="ghost">
            Reset to automatic
          </Button>
        ) : null}
        {!installing && install._tag !== "Failed" && installLog.length > 0 ? (
          <Button className="ml-auto" onClick={() => setShowLog((shown) => !shown)} size="sm" variant="ghost">
            {showLog ? "Hide installer output" : "Show installer output"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
