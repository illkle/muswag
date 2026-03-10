import {
  AlertCircle,
  LoaderCircle,
  Music4,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

import { usePlayer } from "./player-provider";

export function PlayerPanel() {
  const player = usePlayer();
  const currentTrack = player.state.currentTrack;
  const durationSeconds = player.state.durationSeconds ?? currentTrack?.duration ?? 0;
  const [draftPosition, setDraftPosition] = useState<number | null>(null);

  useEffect(() => {
    setDraftPosition(null);
  }, [player.state.currentIndex, player.state.status]);

  const sliderValue = draftPosition ?? player.state.positionSeconds;
  const canSeek = currentTrack !== null && durationSeconds > 0;
  const canGoPrevious = player.state.currentIndex > 0 || player.state.positionSeconds > 5;
  const canGoNext =
    player.state.currentTrack !== null && player.state.currentIndex < player.state.queue.length - 1;
  const statusLabel = getStatusLabel(player.state.status);

  const commitSeek = async (nextValue: number) => {
    if (!canSeek) {
      return;
    }

    await player.seek(nextValue);
    setDraftPosition(null);
  };

  return (
    <section className=" border-t h-(--player-height) overflow-hidden grid grid-cols-10 px-4 py-2 gap-4">
      <div className="min-w-0 col-span-2">
        <p className="truncate text-sm font-semibold">
          {currentTrack?.title ?? "Select a track to start playback"}
        </p>
        <p className="truncate text-sm text-muted-foreground">
          {currentTrack
            ? [
                currentTrack.displayArtist ?? currentTrack.artist ?? "Unknown artist",
                currentTrack.album,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" • ")
            : "Album queues are loaded from the track list."}
        </p>
        <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
          {statusLabel}
          {currentTrack
            ? ` • ${player.state.currentIndex + 1} of ${player.state.queue.length}`
            : ""}
        </p>
      </div>

      <div className="flex flex-col gap-2 grow items-center justify-center col-span-6">
        <div className="flex items-center justify-center gap-2 md:justify-end">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              void player.previous();
            }}
            disabled={!canGoPrevious}
            aria-label="Previous track"
          >
            <SkipBack className="size-4" />
          </Button>

          <Button
            size="icon"
            className="rounded-full"
            onClick={() => {
              if (player.state.status === "playing") {
                void player.pause();
                return;
              }

              void player.play();
            }}
            disabled={!currentTrack || player.state.status === "loading"}
            aria-label={player.state.status === "playing" ? "Pause playback" : "Play track"}
          >
            {player.state.status === "playing" ? (
              <Pause className="size-5" />
            ) : player.state.status === "loading" ? (
              <LoaderCircle className="size-5 animate-spin" />
            ) : (
              <Play className="size-5" />
            )}
          </Button>

          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              void player.next();
            }}
            disabled={!canGoNext}
            aria-label="Next track"
          >
            <SkipForward className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-3 w-full">
          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {formatDuration(sliderValue)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(durationSeconds, 1)}
            step={1}
            value={Math.min(sliderValue, Math.max(durationSeconds, 1))}
            disabled={!canSeek}
            onChange={(event) => {
              setDraftPosition(Number(event.target.value));
            }}
            onBlur={(event) => {
              void commitSeek(Number(event.target.value));
            }}
            onPointerUp={(event) => {
              void commitSeek(Number(event.currentTarget.value));
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
          <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatDuration(durationSeconds)}
          </span>
        </div>
      </div>
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

function getStatusLabel(status: ReturnType<typeof usePlayer>["state"]["status"]): string {
  switch (status) {
    case "loading":
      return "Buffering";
    case "playing":
      return "Playing";
    case "paused":
      return "Paused";
    case "ended":
      return "Finished";
    case "error":
      return "Playback error";
    default:
      return "Idle";
  }
}
