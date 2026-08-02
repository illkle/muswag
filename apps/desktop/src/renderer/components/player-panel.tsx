import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerXIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { eq, useLiveQuery } from "@tanstack/react-db";

import { Button } from "#/components/ui/button";
import { PlayerIPC } from "#/lib/ipc";
import { db } from "#/lib/db-renderer";
import { cn } from "#/lib/utils";

import {
  usePlayerCanGoBack,
  usePlayerCanGoForward,
  usePlayerCanPlay,
  usePlayerCanSeek,
  usePlayerCurrentTrackId,
  usePlayerDuration,
  usePlayerMuted,
  usePlayerPositionSeconds,
  usePlayerStatus,
  usePlayerVolumePercent,
} from "./player-provider";
import { AlbumCover } from "#/components/album-list/album-cover";
import { ArtistLinks } from "#/components/utils/artist-links";
import { Link } from "@tanstack/react-router";

const PlayerButtonControls = (props: React.HTMLAttributes<HTMLDivElement>) => {
  const canGoBack = usePlayerCanGoBack();
  const canGoForward = usePlayerCanGoForward();
  const canPlay = usePlayerCanPlay();
  const status = usePlayerStatus();

  return (
    <div {...props} className={cn("flex items-center justify-center gap-2", props.className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void PlayerIPC.previous();
        }}
        disabled={!canGoBack}
        aria-label="Previous track"
      >
        <SkipBackIcon className="size-4" />
      </Button>

      <Button
        size="icon"
        className="h-7 rounded-full"
        onClick={() => {
          if (status === "playing") {
            void PlayerIPC.pause();
            return;
          }

          void PlayerIPC.play();
        }}
        disabled={!canPlay}
        aria-label={status === "playing" ? "Pause playback" : "Play track"}
      >
        {status === "playing" ? (
          <PauseIcon className="size-3" />
        ) : status === "loading" ? (
          <SpinnerGapIcon className="size-3 animate-spin" />
        ) : (
          <PlayIcon className="size-3" />
        )}
      </Button>

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void PlayerIPC.next();
        }}
        disabled={!canGoForward}
        aria-label="Next track"
      >
        <SkipForwardIcon className="size-4" />
      </Button>
    </div>
  );
};

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
    <div {...props} className={cn("flex w-full items-center gap-1", props.className)}>
      <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatDuration(positionSeconds)}</span>
      <input
        type="range"
        min={0}
        max={Math.max(durationSeconds, 1)}
        step={1}
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
          if (
            event.key.startsWith("Arrow") ||
            event.key === "Home" ||
            event.key === "End" ||
            event.key === "PageUp" ||
            event.key === "PageDown"
          ) {
            seekInteractionRef.current = "keyboard";
          }
        }}
        onKeyUp={(event) => {
          if (
            event.key.startsWith("Arrow") ||
            event.key === "Home" ||
            event.key === "End" ||
            event.key === "PageUp" ||
            event.key === "PageDown"
          ) {
            void commitSeek(Number(event.currentTarget.value));
          }
        }}
        className={cn(
          "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDuration(durationSeconds)}</span>
    </div>
  );
};

const CurrentTrack = (props: React.HTMLAttributes<HTMLDivElement>) => {
  const currentTrackId = usePlayerCurrentTrackId();
  const currentTrackQuery = useLiveQuery(
    (q) =>
      currentTrackId
        ? q
            .from({ song: db.songs })
            .where(({ song }) => eq(song.id, currentTrackId))
            .findOne()
            .join({ alb: db.albums }, ({ song, alb }) => eq(song.albumId, alb.id))
        : null,
    [currentTrackId],
  );

  const currentTrack = currentTrackQuery.data?.song;
  const alb = currentTrackQuery.data?.alb;

  return (
    <div {...props} className={cn("flex h-full w-full items-center gap-2 overflow-hidden", !currentTrack && "opacity-0", props.className)}>
      <AlbumCover
        coverArtPath={alb?.coverArtPath}
        className="w-10 shrink-0"
        target={alb ? { type: "album", id: alb.id, coverArtId: alb.coverArt ?? null } : undefined}
      />

      {currentTrackId && currentTrack && (
        <div className="flex w-full max-w-[calc(100%-48px)] flex-col">
          <Link
            to={"/app/albums/$albumId"}
            params={{ albumId: alb?.id ?? "" }}
            className="line-clamp-1 block truncate text-xs font-semibold"
          >
            {currentTrack.title}
          </Link>
          <ArtistLinks
            artist={currentTrack.artist}
            artistId={currentTrack.artistId}
            artists={currentTrack.artists}
            className="block truncate text-xs text-muted-foreground"
            linkClassName="hover:text-foreground hover:underline"
          />
        </div>
      )}
    </div>
  );
};

const PlayerVolume = (props: React.HTMLAttributes<HTMLDivElement>) => {
  const muted = usePlayerMuted();
  const volumePercent = usePlayerVolumePercent();
  const [draftVolumePercent, setDraftVolumePercent] = useState<number | null>(null);
  const visibleVolumePercent = draftVolumePercent ?? volumePercent;
  const VolumeIcon = muted || visibleVolumePercent === 0 ? SpeakerXIcon : visibleVolumePercent < 50 ? SpeakerLowIcon : SpeakerHighIcon;

  useEffect(() => {
    setDraftVolumePercent(null);
  }, [volumePercent]);

  const commitVolume = (nextVolumePercent: number) => {
    const boundedVolumePercent = Math.min(100, Math.max(0, Math.round(nextVolumePercent)));

    setDraftVolumePercent(boundedVolumePercent);
    if (muted && boundedVolumePercent > 0) {
      void PlayerIPC.setMuted(false);
    }
    void PlayerIPC.setVolume(boundedVolumePercent);
  };

  return (
    <div {...props} className={cn("flex h-full min-w-0 items-center justify-end", props.className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void PlayerIPC.setMuted(!muted);
        }}
        aria-label={muted ? "Unmute playback" : "Mute playback"}
        title={muted ? "Unmute" : "Mute"}
      >
        <VolumeIcon className="size-4" />
      </Button>

      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={visibleVolumePercent}
        onChange={(event) => {
          commitVolume(Number(event.target.value));
        }}
        aria-label="Playback volume"
        className={cn(
          "h-1.5 w-full max-w-28 cursor-pointer appearance-none rounded-full bg-muted accent-primary",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
    </div>
  );
};

//

export function PlayerPanel() {
  return (
    <div className="absolute bottom-0 left-1/2 z-100 h-(--player-height) w-8/10 -translate-x-1/2 pb-2">
      <section className="grid h-full grid-cols-9 flex-col justify-between gap-1 overflow-hidden rounded-lg border border-muted/20 bg-background/90 p-2 px-2 backdrop-blur-sm">
        <CurrentTrack className="col-span-3 row-start-1" />
        <PlayerButtonControls className="col-span-3 row-start-1" />
        <PlayerVolume className="col-span-3 row-start-1" />
        <PlayerSeek className="col-span-9 row-start-2 row-end-2" />
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
