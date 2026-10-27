import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  FolderOpenIcon,
  PlayIcon,
  SpinnerGapIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { createStore, useSelector } from "@tanstack/react-store";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { CopyButton, HostLink, managerNames, mpvSourceLabels, useBusy, useOpenTerminal } from "#/components/settings/mpv-setup";
import { Disclosure } from "#/components/ui-custom/disclosure";
import { InlineError } from "#/components/ui-custom/inline-error";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { MpvIPC, PlayerIPC } from "#/player/commands";
import { usePlayerError, usePlayerMpvBinary } from "#/player/hooks";
import { cn } from "#/lib/utils";
import type { BinaryState, MpvInstallOption } from "#shared/commands/player";

export const mpvStatusLabels: Record<BinaryState["_tag"], string> = {
  Checking: "Checking",
  Ready: "Available",
  // The menu names an unavailable mpv by its verdict (`readUnavailable`); this is the fallback.
  Unavailable: "Not ready",
};

/** Whether the dialog is open. Anything that finds playback broken can open it: the server menu, the player's error. */
const dialogOpen = createStore(false);
export const openMpvDialog = () => dialogOpen.setState(() => true);
const setDialogOpen = (open: boolean) => dialogOpen.setState(() => open);
/** Whether the dialog is open, so the player's own notice can step aside for it. */
export const useMpvDialogOpen = () => useSelector(dialogOpen);

/** A hint or detail line, which reads as a fragment: no full stop at its end. */
const fragment = (text: string) => text.replace(/\.$/, "");

/**
 * Why there is no mpv, from main's message: the version it turned down for the title when it says one, a short
 * verdict for the red line, and the rest to read under it. A message it does not know is split at its first
 * sentence.
 */
export function readUnavailable(message: string): { version: string | null; verdict: string; detail: string | null } {
  const old = /mpv (\S+) is too old\. \S+ requires mpv (\S+) or newer/.exec(message);
  if (old) return { version: old[1] ?? null, verdict: "Too old", detail: `muswag needs ${old[2]} or newer` };
  if (message.startsWith("mpv was not found")) return { version: null, verdict: "Not found", detail: null };
  // "The mpv at /x cannot be used. <why>": which one is said under the verdict, so only the why is kept here.
  const cannot = message.indexOf(" cannot be used. ");
  if (cannot >= 0) return { version: null, verdict: "Can’t be used", detail: fragment(message.slice(cannot + " cannot be used. ".length)) };
  const end = message.indexOf(". ");
  if (end < 0) return { version: null, verdict: fragment(message), detail: null };
  return { version: null, verdict: message.slice(0, end), detail: fragment(message.slice(end + 2)) };
}

const onMac = navigator.userAgent.includes("Mac");

/** A playback error's first sentence, which says what went wrong, and the rest of it. */
function splitCause(message: string): { verdict: string; context: string | null; rest: string | null } {
  const end = message.indexOf(". ");
  const cause = end < 0 ? fragment(message) : message.slice(0, end);
  const rest = end < 0 ? null : message.slice(end + 2);
  // "mpv stopped unexpectedly while loading …": the red line says what happened, the line under it when.
  const at = cause.indexOf(" while ");
  if (at < 0) return { verdict: cause, context: null, rest };
  return { verdict: cause.slice(0, at), context: `While ${cause.slice(at + " while ".length)}`, rest };
}

/** A red verdict with what it means in muted text under it. */
function Problem({ verdict, detail }: { verdict: string; detail: string | null }) {
  return (
    <div>
      <InlineError>{verdict}</InlineError>
      {detail ? <p className="pl-5 text-xs [overflow-wrap:anywhere] text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/** A small action written into a line of text, such as "Reset to automatic". */
function TextButton({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="-my-0.5 rounded-sm py-0.5 text-muted-foreground underline decoration-muted-foreground/30 underline-offset-2 transition-colors outline-none hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/**
 * A path as a person knows it: the home folder as `~`, and an app's mpv as the app. Cut short in the middle
 * when it still does not fit, so its end stays readable; whole on hover.
 */
function MiddlePath({ path, indent = true }: { path: string; indent?: boolean }) {
  const shown = path.replace(/^\/(?:Users|home)\/[^/]+/, "~").replace(/(\.app)\/Contents\/MacOS\/[^/]+$/, "$1");
  const separators = [...shown.matchAll(/[\\/]/g)].map((match) => match.index);
  const cut = separators.length >= 2 ? separators[separators.length - 2] : 0;
  return (
    <div title={path} className={cn("flex min-w-0 font-mono text-[11px] leading-4 text-muted-foreground", indent && "pl-5")}>
      <span className="truncate">{shown.slice(0, cut)}</span>
      <span className="shrink-0">{shown.slice(cut)}</span>
    </div>
  );
}

/** A command that copies itself when clicked, saying so for a moment: the line is the target, not a tiny icon. */
function CommandLine({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <button
      type="button"
      title="Copy command"
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      className={cn(
        "group/command -mx-1.5 flex min-h-5 max-w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] text-foreground/80 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      <code className="truncate">{text}</code>
      {copied ? (
        <span className="flex shrink-0 items-center gap-1 font-sans">
          <CheckIcon className="size-3.5" />
          Copied
        </span>
      ) : (
        <CopyIcon className="size-3.5 shrink-0 text-muted-foreground group-hover/command:text-foreground" />
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : null}
      </span>
    </button>
  );
}

/** One package manager as a settings row: the command under its name, and the way to run it on the right. */
function InstallRow({ option, primary }: { option: MpvInstallOption; primary: boolean }) {
  const { error, opening, open } = useOpenTerminal(option.method);
  const verb = ` ${option.command} `.includes(" upgrade ") ? "Upgrade" : "Install";

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm">
            {verb} with {managerNames[option.method]}
          </div>
          {/* Without the package manager the command cannot run yet: say so first. Main offers the terminal once
              the package manager is there, which a check finds. */}
          {option.terminal ? (
            <p className="text-xs text-muted-foreground">
              {/* An upgrade fixes the mpv it turned down only if that mpv came from the package manager. */}
              {option.note ? fragment(option.note) : verb === "Upgrade" ? `For an mpv installed with ${managerNames[option.method]}` : "Opens a terminal, then checks again"}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Install it, then press Check again</p>
          )}
          {/* The command is for once the package manager is there; until then the row's step is getting it. */}
          {option.terminal ? <CommandLine text={option.command} /> : null}
        </div>
        {option.terminal ? (
          <Button size="sm" variant={primary ? "default" : "outline"} className="mt-0.5 shrink-0" disabled={opening} onClick={open}>
            {opening ? <SpinnerGapIcon className="animate-spin" /> : <TerminalWindowIcon />}
            Run in terminal
          </Button>
        ) : option.url ? (
          // Getting the package manager is the step to take now; the command above copies itself for after.
          <Button size="sm" variant={primary ? "default" : "outline"} className="mt-0.5 shrink-0" nativeButton={false} render={<a href={option.url} rel="noreferrer" target="_blank" />}>
            <ArrowSquareOutIcon />
            Get {managerNames[option.method]}…
          </Button>
        ) : (
          <CopyButton size="sm" label="Copy command" text={option.command} className="mt-0.5" />
        )}
      </div>
      {error ? <InlineError alert>{error}</InlineError> : null}
    </div>
  );
}

/**
 * Which mpv main turned down, from the start of its message ("The mpv on PATH cannot be used", "The mpv at /x
 * cannot be used", "… (/x) cannot be used"): a path, or that it was the one on PATH.
 */
function rejectedMpv(message: string): { path: string | null; onPath: boolean; chosen: boolean } {
  const subject = message.slice(0, Math.max(0, message.indexOf(" cannot be used")));
  if (subject === "The mpv on PATH") return { path: null, onPath: true, chosen: false };
  const at = /^The mpv at (.+)$/.exec(subject) ?? /\((.+)\)$/.exec(subject);
  // One the user chose is the only one tried, so they need a way back to letting muswag find one.
  return { path: at?.[1] ?? null, onPath: false, chosen: subject.startsWith("The mpv you selected") };
}

function UnavailableStatus({ message }: { message: string }) {
  const { version, verdict, detail } = readUnavailable(message);
  // For an mpv it turned down, which one: the fix offered below may upgrade a different one.
  const rejected = rejectedMpv(message);
  return (
    <>
      <div className="text-sm tabular-nums">{version ? `mpv ${version}` : "mpv"}</div>
      <Problem verdict={verdict} detail={detail} />
      {rejected.onPath ? <p className="pl-5 text-xs text-muted-foreground">On PATH</p> : null}
      {rejected.path ? <MiddlePath path={rejected.path} /> : null}
      {/* Its way out, "Reset to automatic", takes the row's button. */}
      {rejected.chosen ? <p className="pl-5 text-xs text-muted-foreground">Chosen by you</p> : null}
    </>
  );
}

/** Which mpv plays, and where it came from; or why there is none. */
function EngineStatus({ binary, busy, healthy, onReset }: { binary: BinaryState; busy: boolean; healthy: boolean; onReset: () => void }) {
  switch (binary._tag) {
    case "Checking":
      return (
        <div className="min-w-0">
          <div className="text-sm">mpv</div>
          <div className="text-xs text-muted-foreground">Searching…</div>
        </div>
      );
    case "Ready":
      return (
        <div className="min-w-0">
          <div className="text-sm tabular-nums">mpv {binary.version.split("-")[0]}</div>
          <div className="text-xs text-muted-foreground">
            {/* The one lime mark, as the updates dialog's "Up to date", and only when all is well: beside a
                playback error, found is a plain fact. */}
            {healthy ? <CheckCircleIcon aria-label="Ready" weight="fill" className="mr-1.5 inline size-3.5 -translate-y-px text-brand" /> : null}
            {/* How it was found matters only when the user or the environment chose it; the path says where. */}
            {binary.source === "manual" || binary.source === "env" ? mpvSourceLabels[binary.source] : /[\\/]/.test(binary.path) ? "Found" : mpvSourceLabels.path}
            {/* A path the user chose stays until they hand the choice back. */}
            {binary.source === "manual" ? (
              <>
                {" · "}
                <TextButton disabled={busy} onClick={onReset}>
                  Reset to automatic
                </TextButton>
              </>
            ) : null}
          </div>
          {/* A path is one long word: cut short here, whole on hover. A bare name says nothing the title does not. */}
          {/[\\/]/.test(binary.path) ? <MiddlePath path={binary.path} indent={healthy} /> : null}
        </div>
      );
    case "Unavailable":
      return (
        <div className="min-w-0">
          <UnavailableStatus message={binary.message} />
        </div>
      );
  }
}

/**
 * The player's engine as the server menu opens it: one column, built like the other settings dialogs. The
 * setup page lays the same parts out its own way (`mpv-setup.tsx`).
 */
export function MpvInfoDialog() {
  const open = useSelector(dialogOpen);
  const binary = usePlayerMpvBinary();
  const playerError = usePlayerError();
  // One for each action, so each spins its own button and says under it why it failed.
  const [rechecking, recheck, recheckError] = useBusy();
  const [retrying, retry, retryError] = useBusy();
  const [busy, run, runError] = useBusy();
  const [resetting, reset, resetError] = useBusy();
  const popupRef = useRef<HTMLDivElement>(null);

  // A check keeps the last result on screen, so the dialog does not shrink and grow back while it runs.
  const settled = useRef<BinaryState | null>(null);
  if (binary._tag !== "Checking") settled.current = binary;
  const shown = binary._tag === "Checking" && settled.current ? settled.current : binary;
  const checking = rechecking || binary._tag === "Checking";
  const chosenBroken = shown._tag === "Unavailable" && rejectedMpv(shown.message).chosen;
  const playbackCause = splitCause(playerError?.message ?? "");
  const installOptions = shown._tag === "Unavailable" ? shown.options : [];
  // One filled button: the first option that runs, or else the first one's way to get its package manager.
  const primaryOption = Math.max(
    0,
    installOptions.findIndex((option) => option.terminal),
  );

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      {/* Focus starts on the dialog itself, so opening it with the pointer rings and pops up nothing. */}
      <DialogContent ref={popupRef} initialFocus={popupRef} placement="top" className="scrollbar scrollbar-flush scrollbar-popup max-h-[85vh] overflow-y-auto *:min-w-0">
        <DialogHeader>
          <DialogTitle>Playback engine</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* What brought the user here, so it comes first. An error asking for mpv says what the mpv row does. */}
          {playerError && playerError.fix !== "mpv" ? (
            <div className="space-y-1.5 border-b pb-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm">Playback</div>
                  <Problem verdict={playbackCause.verdict} detail={playbackCause.context} />
                </div>
                {playerError.fix === "retry" ? (
                  <Button size="sm" className="mt-0.5 shrink-0" disabled={retrying} onClick={() => retry(() => PlayerIPC.play())}>
                    {retrying ? <SpinnerGapIcon className="animate-spin" /> : <PlayIcon />}
                    Retry playback
                  </Button>
                ) : null}
              </div>
              {retryError ? <InlineError alert>{retryError}</InlineError> : null}
              {/* What is left after the cause, such as the exit code, is for whoever looks into it. */}
              {playbackCause.rest ? (
                <Disclosure label="Show details" openLabel="Hide details">
                  <p className="whitespace-pre-wrap">{playbackCause.rest}</p>
                </Disclosure>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2.5">
            {/* The button stays level with the first two lines, however many the status takes. */}
            <div className="flex items-start justify-between gap-4">
              <EngineStatus binary={shown} busy={busy || resetting || checking} healthy={!playerError} onReset={() => reset(() => MpvIPC.clearManualPath())} />
              {/* An mpv the user chose is the only one tried, so checking it again changes nothing: handing the
                  choice back does. */}
              {chosenBroken ? (
                <Button size="sm" variant="outline" className="mt-0.5 shrink-0" disabled={resetting} onClick={() => reset(() => MpvIPC.clearManualPath())}>
                  {resetting ? <SpinnerGapIcon className="animate-spin" /> : <ArrowCounterClockwiseIcon />}
                  Reset to automatic
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="mt-0.5 shrink-0" disabled={checking} onClick={() => recheck(() => MpvIPC.recheck())}>
                  {checking ? <SpinnerGapIcon className="animate-spin" /> : <ArrowsClockwiseIcon />}
                  Check again
                </Button>
              )}
            </div>
            {recheckError ? <InlineError alert>{recheckError}</InlineError> : null}
            {resetError ? <InlineError alert>{resetError}</InlineError> : null}
            {/* Where it looked answers "not found"; for an mpv it turned down, the lines above say which. */}
            {shown._tag === "Unavailable" && shown.searched.length > 0 && readUnavailable(shown.message).verdict === "Not found" ? (
              <Disclosure label="Show where muswag looked" openLabel="Hide where muswag looked">
                <ul className="font-mono text-[11px]">
                  <li>Folders on your PATH</li>
                  {shown.searched.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </div>

          {installOptions.length > 0 ? (
            <div className="space-y-4 border-t pt-4">
              {installOptions.map((option, index) => (
                <InstallRow key={option.method} option={option} primary={index === primaryOption} />
              ))}
            </div>
          ) : null}

          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="min-w-0">
              <div className="text-sm">{shown._tag === "Ready" ? "Use a different mpv" : "Manual install"}</div>
              {/* The picker takes mpv.app as it is, so there is no executable to hunt for inside it. */}
              <p className="text-xs text-muted-foreground">
                {shown._tag === "Ready" ? (
                  <>Choose an installed mpv{onMac ? " or mpv.app" : ""}</>
                ) : (
                  <>
                    Get it from <HostLink quiet url="https://mpv.io/installation/" />, then choose {onMac ? "mpv.app" : "it"}
                  </>
                )}
              </p>
            </div>
            <Button size="sm" variant="outline" className="mt-0.5 shrink-0" disabled={busy || checking} onClick={() => run(() => MpvIPC.locate())}>
              {busy ? <SpinnerGapIcon className="animate-spin" /> : <FolderOpenIcon />}
              Choose mpv…
            </Button>
          </div>
          {runError ? (
            <InlineError alert className="-mt-2">
              {runError}
            </InlineError>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
