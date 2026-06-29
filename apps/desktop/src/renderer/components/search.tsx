import { AlbumCover } from "#/components/album-cover";
import { FuzeSearch } from "#/lib/db-renderer";
import type { SearchResult, SearchResultAlbum, SearchResultSong } from "@muswag/shared";
import { useNavigate } from "@tanstack/react-router";

const InnerResult = ({
  title,
  subtitle,
  coverPath,
  className,
  ...props
}: React.ComponentProps<"div"> & { title?: string; subtitle?: string; coverPath?: string }) => {
  return (
    <div
      className={cn("flex gap-2 h-12 items-center data-highlighted:bg-primary data-highlighted:text-secondary rounded-lg px-2", className)}
      {...props}
    >
      <div className="w-10 shrink-0">
        <AlbumCover key={coverPath} coverArtPath={coverPath} />
      </div>
      <div>
        <div className="line-clamp-1">{title}</div>
        <div className="line-clamp-1">{subtitle}</div>
      </div>
    </div>
  );
};

const SongResult = ({ song }: { song: SearchResultSong }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={<InnerResult title={song.title} subtitle={song.album} coverPath={song.coverArtPath} />}
      onClick={() => n({ to: "/app/albums/$albumId", params: { albumId: song.albumId ?? "n" } })}
    ></Autocomplete.Item>
  );
};

const AlbumResult = ({ album }: { album: SearchResultAlbum }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={<InnerResult title={album.name} subtitle={album.artist} coverPath={album.coverArtPath} />}
      onClick={() => n({ to: "/app/albums/$albumId", params: { albumId: album.id } })}
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
        className="h-7 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
      />

      <Autocomplete.Portal>
        <Autocomplete.Positioner className="outline-hidden" sideOffset={4} align="start">
          <Autocomplete.Popup
            className="w-(--anchor-width) max-w-(--available-width) bg-secondary shadow-2xl rounded-b-xl px-1"
            aria-busy={isPending || undefined}
          >
            <div className="max-h-[min(var(--available-height),22.5rem)] overflow-y-auto overscroll-contain py-1 scroll-pt-1 scroll-pb-1">
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
