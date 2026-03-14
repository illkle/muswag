import { LoaderCircle, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { songQueryOptions } from "#/lib/app-state";
import { PlayerIPC } from "#/lib/db";
import { cn } from "#/lib/utils";

import {
  usePlayerCanGoBack,
  usePlayerCanGoForward,
  usePlayerCanPlay,
  usePlayerCanSeek,
  usePlayerCurrentTrackId,
  usePlayerDuration,
  usePlayerPositionSeconds,
  usePlayerStatus,
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
  const draftPositionRef = useRef<number | null>(null);
  const seekInteractionRef = useRef<"pointer" | "keyboard" | null>(null);

  const setDraft = (nextDraft: number | null) => {
    draftPositionRef.current = nextDraft;
    setDraftPosition(nextDraft);
  };

  useEffect(() => {
    setDraft(null);
  }, [currentTrackId, status]);

  const sliderValue = draftPosition ?? positionSeconds;

  const commitSeek = async (nextValue: number) => {
    if (!canSeek) {
      seekInteractionRef.current = null;
      setDraft(null);
      return;
    }

    seekInteractionRef.current = null;
    setDraft(null);
    await PlayerIPC.seek(nextValue);
  };

  return (
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
        onPointerDown={() => {
          seekInteractionRef.current = "pointer";
        }}
        onChange={(event) => {
          setDraft(Number(event.target.value));
        }}
        onPointerUp={(event) => {
          if (seekInteractionRef.current === "pointer" && draftPositionRef.current !== null) {
            void commitSeek(Number(event.currentTarget.value));
          }
        }}
        onBlur={(event) => {
          if (seekInteractionRef.current !== null && draftPositionRef.current !== null) {
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
      <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatDuration(durationSeconds)}
      </span>
    </div>
  );
};

const CurrentTrack = () => {
  const currentTrackId = usePlayerCurrentTrackId();
  const currentTrackQuery = useQuery({
    ...songQueryOptions(currentTrackId ?? "__missing__"),
    enabled: currentTrackId !== null,
  });
  const currentTrack = currentTrackQuery.data;

  return (
    <div className="min-w-0 col-span-2">
      {currentTrackId && currentTrack && (
        <>
          <p className="truncate text-sm font-semibold">{currentTrack.title}</p>
          <p className="truncate text-sm text-muted-foreground">
            {[
              currentTrack.displayArtist ?? currentTrack.artist ?? "Unknown artist",
              currentTrack.album,
            ]
              .filter((value): value is string => Boolean(value))
              .join(" • ")}
          </p>
        </>
      )}
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
