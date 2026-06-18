import { LoaderCircle, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
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

const PlayerButtonControls = () => {
  const canGoBack = usePlayerCanGoBack();
  const canGoForward = usePlayerCanGoForward();
  const canPlay = usePlayerCanPlay();
  const status = usePlayerStatus();

  return (
    <div className="flex items-center justify-center gap-2 md:justify-end">
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => {
          void PlayerIPC.previous();
        }}
        disabled={!canGoBack}
        aria-label="Previous track"
      >
        <SkipBack className="size-4" />
      </Button>

      <Button
        size="icon"
        className="rounded-full"
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
          <Pause className="size-5" />
        ) : status === "loading" ? (
          <LoaderCircle className="size-5 animate-spin" />
        ) : (
          <Play className="size-5" />
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
        <SkipForward className="size-4" />
      </Button>
    </div>
  );
};

const PlayerSeek = () => {
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
    <div className="flex items-center gap-3 w-full">
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatDuration(positionSeconds)}</span>
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
      <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(durationSeconds)}</span>
    </div>
  );
};

const CurrentTrack = () => {
  const currentTrackId = usePlayerCurrentTrackId();
  const currentTrackQuery = useLiveQuery(
    (q) =>
      currentTrackId
        ? q
            .from({ song: db.songs })
            .where(({ song }) => eq(song.id, currentTrackId))
            .findOne()
        : null,
    [currentTrackId],
  );
  const currentTrack = currentTrackQuery.data;

  return (
    <div className="min-w-0 col-span-2">
      {currentTrackId && currentTrack && (
        <>
          <p className="truncate text-sm font-semibold">{currentTrack.title}</p>
          <p className="truncate text-sm text-muted-foreground">
            {[currentTrack.displayArtist ?? currentTrack.artist ?? "Unknown artist", currentTrack.album]
              .filter((value): value is string => Boolean(value))
              .join(" • ")}
          </p>
        </>
      )}
    </div>
  );
};

const PlayerVolume = () => {
  const muted = usePlayerMuted();
  const volumePercent = usePlayerVolumePercent();
  const [draftVolumePercent, setDraftVolumePercent] = useState<number | null>(null);
  const visibleVolumePercent = draftVolumePercent ?? volumePercent;
  const VolumeIcon = muted || visibleVolumePercent === 0 ? VolumeX : visibleVolumePercent < 50 ? Volume1 : Volume2;

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
    <div className="col-span-2 flex min-w-0 items-center justify-end gap-2">
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

      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{visibleVolumePercent}%</span>
    </div>
  );
};

export function PlayerPanel() {
  return (
    <section className=" border-t h-(--player-height) overflow-hidden grid grid-cols-10 px-4 py-2 gap-4">
      <CurrentTrack />
      <div className="flex flex-col gap-2 grow items-center justify-center col-span-6">
        <PlayerButtonControls />
        <PlayerSeek />
      </div>
      <PlayerVolume />
    </section>
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
