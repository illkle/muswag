import { ArrowsClockwiseIcon, CheckCircleIcon, CopyIcon, FolderOpenIcon, SpinnerGapIcon, TerminalWindowIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "#/components/ui/button";
import { MpvIPC } from "#/player/commands";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";
import { usePlayerMpvBinary } from "#/player/hooks";
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

/** A command that wraps only between its words, never after the dashes of `--exact`. */
function Command({ className, text }: { className?: string; text: string }) {
  const words = text.split(" ");
  return (
    <code className={cn(commandClass, className)}>
      {words.map((word, index) => (
        <span key={index}>
          <span className="whitespace-nowrap">{word}</span>
          {index < words.length - 1 ? " " : null}
        </span>
      ))}
    </code>
  );
}

/** What the search found, in one line, as the login form says what went wrong. */
function StatusLine() {
  const binary = usePlayerMpvBinary();
  switch (binary._tag) {
    case "Checking":
      return (
        <Line icon={<SpinnerGapIcon className="animate-spin" />} tone="muted">
          Searching…
        </Line>
      );
    case "Ready":
      return (
        <Line icon={<CheckCircleIcon weight="fill" />} tone="default">
          <span>Found mpv {binary.version}</span>
          <span className="block text-xs text-muted-foreground">
            <Command text={binary.path} /> · {mpvSourceLabels[binary.source]}
          </span>
        </Line>
      );
    case "Unavailable":
      return (
        <Line icon={<WarningCircleIcon weight="fill" />} tone="error">
          {binary.message}
        </Line>
      );
  }
}

function Line({ icon, tone, children }: { icon: ReactNode; tone: "muted" | "default" | "error"; children: ReactNode }) {
  return (
    <div className={cn("flex gap-2 text-sm", tone === "muted" && "text-muted-foreground", tone === "error" && "text-destructive")} role={tone === "error" ? "alert" : "status"}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-3">
      <div className="space-y-1">
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** "common install directories", with where they are on hover once main has said. */
function SearchedPlaces() {
  const binary = usePlayerMpvBinary();
  const searched = binary._tag === "Unavailable" ? binary.searched : [];
  if (searched.length === 0) return <>common install directories</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-4" tabIndex={0} />}>common install directories</TooltipTrigger>
      <TooltipContent className="max-w-md flex-col items-start gap-1" side="bottom">
        {searched.map((path) => (
          <Command key={path} text={path} />
        ))}
      </TooltipContent>
    </Tooltip>
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
      variant="outline"
    >
      {copied ? <CheckCircleIcon /> : <CopyIcon />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function InstallOption({ option, primary }: { option: MpvInstallOption; primary: boolean }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{managerNames[option.method]}</div>
      <Command className="block rounded-md bg-muted px-2.5 py-1.5" text={option.command} />
      <div className="flex flex-wrap gap-2">
        {option.terminal ? (
          <Button
            onClick={() => {
              setError(null);
              void MpvIPC.openTerminal(option.method).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The terminal could not be opened."));
            }}
            variant={primary ? "default" : "outline"}
          >
            <TerminalWindowIcon />
            Run in terminal
          </Button>
        ) : null}
        <CopyButton text={option.command} />
      </div>
      {option.note || option.url ? (
        <p className="text-xs text-muted-foreground">
          {option.note}
          {option.url ? (
            <>
              {" "}
              <a className="[overflow-wrap:anywhere] underline underline-offset-2" href={option.url} rel="noreferrer" target="_blank">
                {option.url}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <Line icon={<WarningCircleIcon weight="fill" />} tone="error">
          {error}
        </Line>
      ) : null}
    </div>
  );
}

/** Looks for mpv again whenever the window is back in front: after a terminal install, say. */
function useRecheckOnFocus(missing: boolean) {
  const missingRef = useRef(missing);
  missingRef.current = missing;
  useEffect(() => {
    const recheck = () => {
      if (missingRef.current) void MpvIPC.recheck().catch(() => {});
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, []);
}

/** Runs one of the user's commands at a time, and says whether one is running. */
function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = (command: () => Promise<unknown>) => {
    setBusy(true);
    void command()
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return [busy, run] as const;
}

/**
 * The automatic search: what it found, and a way to look again. `action` takes the other half of the
 * row: the setup page's way on. It also looks again whenever the window comes back to the front.
 */
export function MpvSearch({ action }: { action?: ReactNode }) {
  const binary = usePlayerMpvBinary();
  const [busy, run] = useBusy();
  useRecheckOnFocus(binary._tag === "Unavailable");

  return (
    <Section
      description={
        <>
          muswag looks for mpv on PATH and in <SearchedPlaces />.
        </>
      }
      title="Auto discovery"
    >
      <StatusLine />
      <div className={cn("grid gap-2 *:w-full", action && "grid-cols-2")}>
        <Button disabled={busy} onClick={() => run(() => MpvIPC.recheck())} variant="outline">
          <ArrowsClockwiseIcon className={busy ? "animate-spin" : undefined} />
          Check again
        </Button>
        {action}
      </div>
    </Section>
  );
}

/** The ways to install mpv: with a package manager, while it is missing, or by hand. */
export function MpvInstall() {
  const binary = usePlayerMpvBinary();
  const [busy, run] = useBusy();
  const installOptions = binary._tag === "Unavailable" ? binary.options : [];
  const firstTerminal = installOptions.findIndex((option) => option.terminal);

  return (
    <div className="min-w-0 space-y-8">
      {installOptions.length > 0 ? (
        <>
          <Section description="muswag opens a terminal that runs the command, and checks again when you come back." title="Install with a package manager">
            <div className="space-y-6">
              {installOptions.map((option, index) => (
                <InstallOption key={option.method} option={option} primary={index === firstTerminal} />
              ))}
            </div>
          </Section>
          <div className="border-t" />
        </>
      ) : null}

      <Section
        description={
          <>
            Get mpv from{" "}
            <a
              className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground"
              href="https://mpv.io/installation/"
              rel="noreferrer"
              target="_blank"
            >
              mpv.io
            </a>
            , then show muswag where its executable is.
          </>
        }
        title="Manual install"
      >
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => run(() => MpvIPC.locate())} variant="outline">
            <FolderOpenIcon />
            Locate mpv…
          </Button>
          {binary._tag === "Ready" && binary.source === "manual" ? (
            <Button disabled={busy} onClick={() => run(() => MpvIPC.clearManualPath())} variant="ghost">
              Reset to automatic
            </Button>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
