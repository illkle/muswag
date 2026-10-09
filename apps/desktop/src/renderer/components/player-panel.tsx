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
  usePlayerIssue,
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
import { cn } from "#/lib/utils";

import { AlbumCover } from "#/components/album-list/album-cover";
import { QueuePanelToggle } from "#/components/queue-panel";
import { ArtistLinks } from "#/components/utils/artist-links";
import { Link } from "@tanstack/react-router";
import { useHotkey } from "@tanstack/react-hotkeys";

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

    void PlayerIPC.play().catch(() => {});
  };

  useHotkey("Space", () => togglePlay());

  return (
    <div {...props} className={cn("flex items-center justify-center gap-1", props.className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void QueueActions.previous().catch(() => {});
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
          void QueueActions.next().catch(() => {});
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
  const ds = usePlayerDuration();
  const canSeek = usePlayerCanSeek();
  const currentTrackId = usePlayerCurrentTrackId();
  const status = usePlayerStatus();
  const positionSeconds = usePlayerPositionSeconds();

  const durationSeconds = ds ?? 0;
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const [optimisticPosition, setOptimisticPosition] = useState<number | null>(null);
  const draftPositionRef = useRef<number | null>(null);
  const optimisticSeekRef = useRef<{ from: number; target: number } | null>(null);
  const seekInteractionRef = useRef<"pointer" | "keyboard" | null>(null);

  const setDraft = (nextDraft: number | null) => {
    draftPositionRef.current = nextDraft;
    setDraftPosition(nextDraft);
  };

  useEffect(() => {
    setDraft(null);
    setOptimisticPosition(null);
    optimisticSeekRef.current = null;
    seekInteractionRef.current = null;
  }, [currentTrackId, status]);

  useEffect(() => {
    if (optimisticPosition === null) {
      return;
    }

    const optimisticSeek = optimisticSeekRef.current;
    if (!optimisticSeek) {
      setOptimisticPosition(null);
      return;
    }

    const isForwardSeek = optimisticSeek.target >= optimisticSeek.from;
    const reachedTarget = isForwardSeek ? positionSeconds >= optimisticSeek.target - 0.25 : positionSeconds <= optimisticSeek.target + 0.25;

    if (Math.abs(positionSeconds - optimisticPosition) < 0.5 || reachedTarget) {
      optimisticSeekRef.current = null;
      setOptimisticPosition(null);
    }
  }, [optimisticPosition, positionSeconds]);

  const sliderValue = draftPosition ?? optimisticPosition ?? positionSeconds;

  const commitSeek = async (nextValue: number) => {
    if (!canSeek) {
      seekInteractionRef.current = null;
      setDraft(null);
      setOptimisticPosition(null);
      return;
    }

    const nextPosition = Math.min(Math.max(nextValue, 0), durationSeconds);

    seekInteractionRef.current = null;
    setDraft(null);
    optimisticSeekRef.current = { from: positionSeconds, target: nextPosition };
    setOptimisticPosition(nextPosition);

    try {
      await PlayerIPC.seek(nextPosition);
    } catch (cause) {
      console.error(cause);
      optimisticSeekRef.current = null;
      setOptimisticPosition(null);
    }
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
            void commitSeek(Number(event.currentTarget.value));
          }
          // A slider that kept the focus would swallow Space and the arrow keys.
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
            void commitSeek(Number(event.currentTarget.value));
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
            seekInteractionRef.current = "keyboard";
            // From the draft as it stands: a held key repeats faster than the slider is rendered again.
            setDraft(Math.min(Math.max((draftPositionRef.current ?? sliderValue) + direction * SEEK_KEY_STEP_SECONDS, 0), durationSeconds));
          } else if (SEEK_KEYS.has(event.key)) {
            seekInteractionRef.current = "keyboard";
          }
        }}
        onKeyUp={(event) => {
          // Letting go of the key that moved the slider, not of a modifier held with it.
          if (seekInteractionRef.current === "keyboard" && SEEK_KEYS.has(event.key)) {
            void commitSeek(draftPositionRef.current ?? Number(event.currentTarget.value));
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
  const albumQuery = useLiveQuery(
    (q) =>
      currentTrack?.albumId
        ? q
            .from({ album: db.albums })
            .where(({ album }) => eq(album.id, currentTrack.albumId))
            .findOne()
        : null,
    [currentTrack?.albumId],
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

  const cover = <AlbumCover coverArtPath={alb?.coverArtPath} thumbnail className="w-10 shrink-0" target={alb ? { type: "album", id: alb.id, coverArtId: alb.coverArt ?? null } : undefined} />;

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
function PlayerIssueBanner() {
  const issue = usePlayerIssue();
  const error = usePlayerError();

  if (!error) return null;

  const actions = issue?.actions ?? [];

  return (
    <div role="alert" className="absolute bottom-full left-1/2 mb-2 flex w-max max-w-full -translate-x-1/2 items-center gap-3 rounded-lg surface-raised px-3 py-1.5 text-sm">
      <WarningIcon weight="fill" className="size-4 shrink-0 text-destructive" />
      <span className="line-clamp-2 min-w-0 py-1.5">{error}</span>

      {issue && actions.length > 0 ? (
        <div className="-mr-1.5 flex shrink-0 items-center gap-1">
          {actions.includes("retry") ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void PlayerIPC.retryIssue(issue.id).catch(() => {});
              }}
            >
              Retry
            </Button>
          ) : null}
          {actions.includes("configureMpv") ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void MpvIPC.locate().catch(() => {});
              }}
            >
              Locate mpv
            </Button>
          ) : null}
          {actions.includes("refreshMpv") ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void MpvIPC.recheck().catch(() => {});
              }}
            >
              Recheck
            </Button>
          ) : null}
          {actions.includes("login") ? (
            <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Log in
            </Link>
          ) : null}
          {actions.includes("dismiss") ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void PlayerIPC.dismissIssue(issue.id).catch(() => {});
              }}
            >
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function PlayerPanel() {
  return (
    // As wide as the list above it, up to a width past which the bar would only gain empty space.
    <div className="absolute bottom-0 left-1/2 z-40 h-(--player-height) w-[min(calc(100%-2rem),60rem)] -translate-x-1/2 pb-1.5">
      <PlayerIssueBanner />
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

function formatDuration(totalSeconds: number | null | undefined): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds === null || totalSeconds === undefined) {
    return "0:00";
  }

  const roundedSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const seconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
