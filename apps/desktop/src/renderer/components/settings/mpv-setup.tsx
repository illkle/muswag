import { ArrowsClockwiseIcon, CheckCircleIcon, CopyIcon, FolderOpenIcon, SpinnerGapIcon, TerminalWindowIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "#/components/ui/button";
import { MpvIPC } from "#/player/commands";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";
import { usePlayerMpvBinary } from "#/player/hooks";
import { cn } from "#/lib/utils";
import type { MpvInstallMethod, MpvInstallOption, MpvSource } from "#shared/commands/player";

export const mpvSourceLabels: Record<MpvSource, string> = {
  env: "MUSWAG_MPV_PATH",
  manual: "Chosen by you",
  cache: "Found at last launch",
  path: "Found on PATH",
  "well-known": "Found in a standard install location",
  "login-shell": "Found on PATH as a new terminal sees it",
};

export const managerNames: Record<MpvInstallMethod, string> = {
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
          <span className="block text-xs text-muted-foreground">{mpvSourceLabels[binary.source]}</span>
          {/* A path is one long word: cut short here, whole on hover. */}
          <span title={binary.path} className="block truncate font-mono text-xs text-muted-foreground">
            {binary.path}
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

/** Copies `text`, and says so for a moment. */
export function CopyButton({ size = "default", text, label = "Copy", className }: { size?: "default" | "sm"; text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <Button
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      size={size}
      variant="outline"
      className={className}
    >
      {copied ? <CheckCircleIcon /> : <CopyIcon />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A link out of the app, named by its host rather than spelled out. */
export function HostLink({ url, quiet = false }: { url: string; quiet?: boolean }) {
  return (
    <a
      className={cn(
        "underline transition-colors",
        // Quiet inside a muted line, as the dialog's other inline actions are; prominent in a paragraph.
        quiet
          ? "decoration-muted-foreground/30 underline-offset-2 hover:text-foreground hover:decoration-foreground"
          : "font-medium text-foreground decoration-foreground/30 underline-offset-4 hover:decoration-foreground",
      )}
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {new URL(url).hostname}
    </a>
  );
}

/** One package manager's command, with a way to run or copy it. `size` is the buttons'. */
/** Opens a terminal that runs `method`'s command, and says why when it cannot. */
export function useOpenTerminal(method: MpvInstallMethod) {
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const open = () => {
    setError(null);
    setOpening(true);
    void MpvIPC.openTerminal(method)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The terminal could not be opened."))
      .finally(() => setOpening(false));
  };
  return { error, opening, open };
}

export function InstallOption({ option, primary, size = "default", title = managerNames[option.method] }: { option: MpvInstallOption; primary: boolean; size?: "default" | "sm"; title?: ReactNode }) {
  const { error, opening, open } = useOpenTerminal(option.method);
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{title}</div>
      {/* What to do first, before the command it is about. */}
      {option.note || option.url ? (
        <p className="text-xs text-muted-foreground">
          {option.note}
          {option.url ? (
            <>
              {" "}
              <HostLink url={option.url} />
            </>
          ) : null}
        </p>
      ) : null}
      <Command className="block rounded-md bg-muted px-2.5 py-1.5" text={option.command} />
      <div className="flex flex-wrap gap-2">
        {option.terminal ? (
          <Button disabled={opening} onClick={open} size={size} variant={primary ? "default" : "outline"}>
            <TerminalWindowIcon />
            Run in terminal
          </Button>
        ) : null}
        <CopyButton size={size} text={option.command} />
      </div>
      {error ? (
        <Line icon={<WarningCircleIcon weight="fill" />} tone="error">
          {error}
        </Line>
      ) : null}
    </div>
  );
}

/** Runs one of the user's commands at a time, and says whether one is running and why the last one failed. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (command: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void command()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "That did not work."))
      .finally(() => setBusy(false));
  };
  return [busy, run, error] as const;
}

/**
 * The automatic search: what it found, and a way to look again. `action` takes the other half of the
 * row: the setup page's way on.
 */
export function MpvSearch({ action }: { action?: ReactNode }) {
  const [busy, run] = useBusy();

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
