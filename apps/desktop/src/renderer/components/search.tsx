import { AlbumCover } from "#/components/album-list/album-cover";
import { FuzeSearch } from "#/lib/db-renderer";
import type { SearchResult, SearchResultAlbum, SearchResultSong } from "@muswag/shared";
import { useNavigate } from "@tanstack/react-router";

const InnerResult = ({
  title,
  subtitle,
  coverPath,
  target,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  title?: string;
  subtitle?: string;
  coverPath?: string;
  target?: import("@muswag/shared").CoverTarget;
}) => {
  return (
    <div className={cn("flex h-12 items-center gap-2 rounded-lg px-2 data-highlighted:bg-primary/10", className)} {...props}>
      <div className="w-10 shrink-0">
        <AlbumCover key={coverPath} coverArtPath={coverPath} target={target} />
      </div>
      <div>
        <div className="line-clamp-1 text-xs">{title}</div>
        <div className="line-clamp-1 text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  );
};

const SongResult = ({ song }: { song: SearchResultSong }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={
        <InnerResult
          title={song.title}
          subtitle={song.artist}
          coverPath={song.coverArtPath}
          target={song.albumId ? { type: "album", id: song.albumId, coverArtId: song.coverArt ?? null } : undefined}
        />
      }
      onClick={() => n({ to: "/app/albums/$albumId", params: { albumId: song.albumId ?? "n" }, resetScroll: true })}
    ></Autocomplete.Item>
  );
};

const AlbumResult = ({ album }: { album: SearchResultAlbum }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={
        <InnerResult
          title={album.name}
          subtitle={album.artist}
          coverPath={album.coverArtPath}
          target={{ type: "album", id: album.id, coverArtId: album.coverArt ?? null }}
        />
      }
      onClick={() => n({ to: "/app/albums/$albumId", params: { albumId: album.id }, resetScroll: true })}
    ></Autocomplete.Item>
  );
};

import { Autocomplete } from "@base-ui/react/autocomplete";
import type { FuseResult } from "fuse.js";
import { useRef, useState, useTransition } from "react";
import { cn } from "#/lib/utils";

export function MiniSearch() {
  const [searchValue, setSearchValue] = useState("");
  const [searchResults, setSearchResults] = useState<FuseResult<SearchResult>[]>([]);

  const [isPending, startTransition] = useTransition();

  const abortControllerRef = useRef<AbortController | null>(null);

  return (
    <Autocomplete.Root
      items={searchResults}
      value={searchValue}
      openOnInputClick
      onValueChange={(nextSearchValue) => {
        setSearchValue(nextSearchValue);

        const controller = new AbortController();
        abortControllerRef.current?.abort();
        abortControllerRef.current = controller;

        if (nextSearchValue === "") {
          setSearchResults([]);
          return;
        }

        startTransition(async () => {
          const result = await FuzeSearch.search(nextSearchValue, { limit: 20 });
          if (controller.signal.aborted) {
            return;
          }

          startTransition(() => {
            setSearchResults(result);
          });
        });
      }}
      itemToStringValue={(item) => item.item.id}
      filter={null}
    >
      <Autocomplete.Input
        placeholder="Search..."
        className="relative z-20 h-full w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
      />

      <Autocomplete.Portal>
        <Autocomplete.Positioner className="z-20 outline-hidden" sideOffset={4} align="start">
          <Autocomplete.Popup
            className="w-(--anchor-width) max-w-(--available-width) rounded-md bg-background px-1 shadow-2xl"
            aria-busy={isPending || undefined}
          >
            <div className="max-h-[min(var(--available-height),22.5rem)] scroll-pt-1 scroll-pb-1 overflow-y-auto overscroll-contain">
              <Autocomplete.List>
                {(v: FuseResult<SearchResult>) => {
                  if (v.item.type === "album") return <AlbumResult album={v.item} />;

                  return <SongResult song={v.item} />;
                }}
              </Autocomplete.List>
            </div>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
