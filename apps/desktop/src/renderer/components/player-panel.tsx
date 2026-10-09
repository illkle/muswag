import { MusicNotesIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, SpeakerHighIcon, SpeakerLowIcon, SpeakerXIcon, SpinnerGapIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { eq, useLiveQuery } from "@tanstack/react-db";

import { Button, buttonVariants } from "#/components/ui/button";
import { Slider } from "#/components/ui-custom/slider";
import { MpvIPC, PlayerIPC } from "#/player/commands";
import { db } from "#/data/library";
import { QueueActions } from "#/queue/queue";
import {
  usePlayerCanGoBack,
  usePlayerCanGoForward,
  usePlayerCanPlay,
  usePlayerConnected,
  usePlayerError,
  usePlayerCanSeek,
  usePlayerBuffering,
  usePlayerCurrentTrackId,
  usePlayerCurrentTrack,
  usePlayerDuration,
  usePlayerMuted,
  usePlayerPositionSeconds,
  usePlayerStatus,
  usePlayerVolumePercent,
} from "#/player/hooks";
import { formatDuration } from "#/lib/format";
import { failureNotice } from "#/lib/notify";
import { cn } from "#/lib/utils";

import { AlbumCover } from "#/components/album-list/album-cover";
import { QueuePanelToggle } from "#/components/queue-panel";
import { ArtistLinks } from "#/components/utils/artist-links";
import { Link } from "@tanstack/react-router";
import { useHotkey } from "@tanstack/react-hotkeys";

/**
 * Whether Space is for the element that has the focus rather than for playback: a field to type in, a
 * control the user reached with the keyboard, or anything in a dialog or a menu, which own the keyboard
 * while they are open. A button that only kept the focus from a click is not one of them, and neither is
 * a slider, which does nothing with Space.
 */
function takesSpace(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return true;
  if (element instanceof HTMLInputElement) return element.type !== "range";
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element.isContentEditable) return true;
  return element.matches("button, summary, [role=button]") && element.matches(":focus-visible");
}

const PlayerButtonControls = (props: React.HTMLAttributes<HTMLDivElement>) => {
  const canGoBack = usePlayerCanGoBack();
  const canGoForward = usePlayerCanGoForward();
  const canPlay = usePlayerCanPlay();
  const status = usePlayerStatus();
  const buffering = usePlayerBuffering();

  const togglePlay = () => {
    if (!canPlay) return;
    if (status === "playing") {
      void PlayerIPC.pause().catch(() => {});
      return;
    }

    // With no track in the player, Play starts the queue. What the player fails at is in its banner; what the queue fails at has no place but a notice.
    if (status === "idle") void QueueActions.play().catch(failureNotice("The queue could not be started."));
    else void PlayerIPC.play().catch(() => {});
  };

  // The library would skip every input, sliders included, and would take Space from a focused button
  // without asking: so it is told to do neither, and the press is only claimed when it is playback's.
  useHotkey(
    "Space",
    (event) => {
      if (takesSpace(document.activeElement)) return;
      event.preventDefault();
      togglePlay();
    },
    { ignoreInputs: false, preventDefault: false, stopPropagation: false },
  );

  return (
    <div {...props} className={cn("flex items-center justify-center gap-1", props.className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void QueueActions.previous().catch(failureNotice("The previous track could not be played."));
        }}
        disabled={!canGoBack}
        aria-label="Previous track"
        title="Previous"
      >
        <SkipBackIcon weight="fill" className="size-4" />
      </Button>

      <Button size="icon-sm" className="mx-1 rounded-full" onClick={togglePlay} disabled={!canPlay} aria-label={status === "playing" ? "Pause playback" : "Play track"}>
        {status === "loading" || buffering ? (
          <SpinnerGapIcon className="size-4 animate-spin" />
        ) : status === "playing" ? (
          <PauseIcon weight="fill" className="size-4" />
        ) : (
          <PlayIcon weight="fill" className="size-4" />
        )}
      </Button>

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void QueueActions.next().catch(failureNotice("The next track could not be played."));
        }}
        disabled={!canGoForward}
        aria-label="Next track"
        title="Next"
      >
        <SkipForwardIcon weight="fill" className="size-4" />
      </Button>
    </div>
  );
};

/** Wide enough for the times of most tracks, so the slider between them keeps its length as they change. */
const TIME_LABEL = "min-w-9 shrink-0 text-xs text-muted-foreground tabular-nums";
/** Stands in for both times while nothing is loaded. */
const NO_TIME = "–:––";
/** How far an arrow key seeks. */
const SEEK_KEY_STEP_SECONDS = 5;
const SEEK_KEY_DIRECTIONS: Record<string, 1 | -1 | undefined> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
/** Every key that moves the seek slider. */
const SEEK_KEYS = new Set([...Object.keys(SEEK_KEY_DIRECTIONS), "Home", "End", "PageUp", "PageDown"]);

const PlayerSeek = (props: React.HTMLAttributes<HTMLDivElement>) => {
  const durationSeconds = usePlayerDuration() ?? 0;
  const canSeek = usePlayerCanSeek();
  const currentTrackId = usePlayerCurrentTrackId();
  const positionSeconds = usePlayerPositionSeconds();

  /** Where the user is dragging or stepping to. Nothing is sent before they let go. */
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  /** The position that was sent, shown until main has answered: by then the state holds where mpv went. */
  const [sentPosition, setSentPosition] = useState<number | null>(null);
  const draftPositionRef = useRef<number | null>(null);
  const seekInteractionRef = useRef<"pointer" | "keyboard" | null>(null);
  /** Counts the seeks sent, so that only the answer to the last one ends `sentPosition`. */
  const seeksSentRef = useRef(0);

  const setDraft = (nextDraft: number | null) => {
    draftPositionRef.current = nextDraft;
    setDraftPosition(nextDraft);
  };

  // A position the user was moving to belongs to the track it was in.
  useEffect(() => {
    setDraft(null);
    setSentPosition(null);
    seekInteractionRef.current = null;
  }, [currentTrackId]);

  const sliderValue = draftPosition ?? sentPosition ?? positionSeconds;

  const commitSeek = (nextValue: number) => {
    seekInteractionRef.current = null;
    setDraft(null);
    if (!canSeek) return;

    const nextPosition = Math.min(Math.max(nextValue, 0), durationSeconds);
    const seek = ++seeksSentRef.current;
    setSentPosition(nextPosition);
    void PlayerIPC.seek(nextPosition)
      // Why it failed is the player's error, which the banner shows.
      .catch(() => {})
      .finally(() => {
        if (seeksSentRef.current === seek) setSentPosition(null);
      });
  };

  return (
    <div {...props} className={cn("flex w-full items-center gap-2", props.className)}>
      <span className={TIME_LABEL}>{currentTrackId ? formatDuration(sliderValue) : NO_TIME}</span>
      <Slider
        max={Math.max(durationSeconds, 1)}
        step={0.01}
        value={Math.min(sliderValue, Math.max(durationSeconds, 1))}
        disabled={!canSeek}
        onPointerDown={(event) => {
          seekInteractionRef.current = "pointer";
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraft(Number(event.currentTarget.value));
        }}
        onChange={(event) => {
          setDraft(Number(event.target.value));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }

          if (seekInteractionRef.current === "pointer") {
            commitSeek(Number(event.currentTarget.value));
          }
          // A slider that kept the focus after a drag would take the arrow keys.
          event.currentTarget.blur();
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }

          seekInteractionRef.current = null;
          setDraft(null);
        }}
        onBlur={(event) => {
          if (seekInteractionRef.current !== null) {
            commitSeek(draftPositionRef.current ?? Number(event.currentTarget.value));
            return;
          }

          seekInteractionRef.current = null;
          setDraft(null);
        }}
        onKeyDown={(event) => {
          const direction = event.metaKey || event.ctrlKey || event.altKey ? undefined : SEEK_KEY_DIRECTIONS[event.key];
          if (direction !== undefined) {
            // The slider's own step is a hundredth of a second, which is right for dragging only.
            event.preventDefault();
            // From the draft as it stands: a held key repeats faster than the slider is rendered again.
            const nextDraft = (draftPositionRef.current ?? sliderValue) + direction * SEEK_KEY_STEP_SECONDS;
            // The end of a track is the start of the next one, so a step that would reach it is not taken.
            if (nextDraft >= durationSeconds) return;
            seekInteractionRef.current = "keyboard";
            setDraft(Math.max(nextDraft, 0));
          } else if (SEEK_KEYS.has(event.key)) {
            seekInteractionRef.current = "keyboard";
          }
        }}
        onKeyUp={(event) => {
          // Letting go of the key that moved the slider, not of a modifier held with it.
          if (seekInteractionRef.current === "keyboard" && SEEK_KEYS.has(event.key)) {
            // End and Page Up reach for the end of the track, which would start the next one: a key stops just short of it.
            commitSeek(Math.min(draftPositionRef.current ?? Number(event.currentTarget.value), Math.max(durationSeconds - SEEK_KEY_STEP_SECONDS, 0)));
          }
        }}
        aria-label="Playback position"
        className="w-full"
      />
      <span className={cn(TIME_LABEL, "text-right")}>{currentTrackId ? formatDuration(durationSeconds) : NO_TIME}</span>
    </div>
  );
};

const CurrentTrack = (props: React.HTMLAttributes<HTMLDivElement>) => {
  const currentTrack = usePlayerCurrentTrack();
  const albumQuery = useLiveQuery((q) =>
    currentTrack?.albumId
      ? q
          .from({ album: db.albums })
          .where(({ album }) => eq(album.id, currentTrack.albumId))
          .findOne()
      : null,
  );

  const alb = albumQuery.data;

  if (!currentTrack) {
    return (
      <div {...props} className={cn("flex min-w-0 items-center gap-2.5", props.className)}>
        <div className="flex size-10 shrink-0 items-center justify-center rounded border border-border bg-muted text-muted-foreground/50">
          <MusicNotesIcon className="size-4" />
        </div>
        <span className="truncate text-sm text-muted-foreground">Nothing playing</span>
      </div>
    );
  }

  const cover = <AlbumCover thumbnail className="w-10 shrink-0" target={alb ? { type: "album", id: alb.id, coverArtId: alb.coverArt ?? null } : undefined} />;

  return (
    <div {...props} className={cn("flex min-w-0 items-center gap-2.5", props.className)}>
      {currentTrack.albumId ? (
        // The title next to it is the same link, so this one stays out of the tab order.
        <Link to="/app/albums/$albumId" params={{ albumId: currentTrack.albumId }} tabIndex={-1} aria-hidden className="shrink-0">
          {cover}
        </Link>
      ) : (
        cover
      )}

      <div className="flex min-w-0 flex-col">
        {currentTrack.albumId ? (
          <Link to="/app/albums/$albumId" params={{ albumId: currentTrack.albumId }} className="truncate text-sm font-medium hover:underline">
            {currentTrack.title}
          </Link>
        ) : (
          <span className="truncate text-sm font-medium">{currentTrack.title}</span>
        )}
        <ArtistLinks
          artist={currentTrack.artist}
          artistId={currentTrack.artistId}
          artists={currentTrack.artists}
          className="block truncate text-xs text-muted-foreground"
          linkClassName="hover:text-foreground hover:underline"
        />
      </div>
    </div>
  );
};

/** Volume changes reach main at most this often while the slider moves. */
const VOLUME_SEND_INTERVAL_MS = 100;

export const PlayerVolume = (props: React.HTMLAttributes<HTMLDivElement>) => {
  const muted = usePlayerMuted();
  const volumePercent = usePlayerVolumePercent();
  /** What the slider shows while the user moves it, and until main has caught up after they let go. */
  const [draftVolumePercent, setDraftVolumePercent] = useState<number | null>(null);
  const interactingRef = useRef(false);
  const unsentVolumeRef = useRef<number | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentAtRef = useRef(-Infinity);
  const sendsInFlightRef = useRef(0);
  const visibleVolumePercent = draftVolumePercent ?? volumePercent;
  const VolumeIcon = muted || visibleVolumePercent === 0 ? SpeakerXIcon : visibleVolumePercent < 50 ? SpeakerLowIcon : SpeakerHighIcon;

  useEffect(
    () => () => {
      if (sendTimerRef.current !== null) clearTimeout(sendTimerRef.current);
    },
    [],
  );

  /** Main's volume takes over only once the user has let go and every change sent has been answered. */
  const releaseDraft = () => {
    if (!interactingRef.current && unsentVolumeRef.current === null && sendsInFlightRef.current === 0) {
      setDraftVolumePercent(null);
    }
  };

  const sendVolume = () => {
    if (sendTimerRef.current !== null) {
      clearTimeout(sendTimerRef.current);
      sendTimerRef.current = null;
    }

    const nextVolumePercent = unsentVolumeRef.current;
    if (nextVolumePercent === null) {
      return;
    }

    unsentVolumeRef.current = null;
    lastSentAtRef.current = performance.now();
    sendsInFlightRef.current++;
    void PlayerIPC.setVolume(nextVolumePercent)
      .catch(() => {})
      .finally(() => {
        sendsInFlightRef.current--;
        releaseDraft();
      });
  };

  const changeVolume = (nextVolumePercent: number) => {
    const boundedVolumePercent = Math.min(100, Math.max(0, Math.round(nextVolumePercent)));

    setDraftVolumePercent(boundedVolumePercent);
    if (muted && boundedVolumePercent > 0) {
      void PlayerIPC.setMuted(false).catch(() => {});
    }

    // Only the latest value is kept between sends.
    unsentVolumeRef.current = boundedVolumePercent;
    if (sendTimerRef.current !== null) {
      return;
    }

    const waitMs = lastSentAtRef.current + VOLUME_SEND_INTERVAL_MS - performance.now();
    if (waitMs <= 0) {
      sendVolume();
    } else {
      sendTimerRef.current = setTimeout(sendVolume, waitMs);
    }
  };

  const endInteraction = () => {
    interactingRef.current = false;
    sendVolume();
    releaseDraft();
  };

  return (
    <div {...props} className={cn("flex min-w-0 items-center justify-end gap-1", props.className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void PlayerIPC.setMuted(!muted).catch(() => {});
        }}
        aria-label={muted ? "Unmute playback" : "Mute playback"}
        title={muted ? "Unmute" : "Mute"}
      >
        <VolumeIcon weight="fill" className="size-4" />
      </Button>

      <Slider
        step={1}
        value={visibleVolumePercent}
        onPointerDown={(event) => {
          interactingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onChange={(event) => {
          changeVolume(Number(event.target.value));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }

          endInteraction();
          event.currentTarget.blur();
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }

          endInteraction();
        }}
        onBlur={endInteraction}
        onKeyDown={(event) => {
          if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End" || event.key === "PageUp" || event.key === "PageDown") {
            interactingRef.current = true;
          }
        }}
        onKeyUp={(event) => {
          if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End" || event.key === "PageUp" || event.key === "PageDown") {
            endInteraction();
          }
        }}
        aria-label="Playback volume"
        className="w-full max-w-28"
      />
    </div>
  );
};

//

/** What went wrong with playback and what can be done about it, floating above the player bar. */
function PlayerErrorBanner() {
  const connected = usePlayerConnected();
  const error = usePlayerError();

  if (!error) return null;

  return (
    <div role="alert" className="absolute bottom-full left-1/2 mb-2 flex w-max max-w-full -translate-x-1/2 items-center gap-3 rounded-lg surface-raised px-3 py-1.5 text-sm">
      <WarningIcon weight="fill" className="size-4 shrink-0 text-destructive" />
      <span className="line-clamp-2 min-w-0 py-1.5">{error.message}</span>

      {connected ? (
        <div className="-mr-1.5 flex shrink-0 items-center gap-1">
          {error.fix === "retry" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void PlayerIPC.play().catch(() => {});
              }}
            >
              Retry
            </Button>
          ) : null}
          {error.fix === "mpv" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void MpvIPC.locate().catch(() => {});
                }}
              >
                Locate mpv
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void MpvIPC.recheck().catch(() => {});
                }}
              >
                Recheck
              </Button>
            </>
          ) : null}
          {error.fix === "login" ? (
            <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Log in
            </Link>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void PlayerIPC.dismissError().catch(() => {});
            }}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function PlayerPanel() {
  return (
    // As wide as the list above it, up to a width past which the bar would only gain empty space.
    <div className="absolute bottom-0 left-1/2 z-40 h-(--player-height) w-[min(calc(100%-2rem),60rem)] -translate-x-1/2 pb-1.5">
      <PlayerErrorBanner />
      <section aria-label="Player" className="grid h-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] content-between gap-x-4 rounded-lg surface-raised p-2">
        <CurrentTrack />
        <PlayerButtonControls />
        <div className="flex min-w-0 items-center justify-end gap-1">
          <PlayerVolume className="flex-1" />
          <QueuePanelToggle />
        </div>
        <PlayerSeek className="col-span-3" />
      </section>
    </div>
  );
}
