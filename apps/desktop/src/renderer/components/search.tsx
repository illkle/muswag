import { AlbumCover } from "#/components/album-list/album-cover";
import { FuzeSearch } from "#/lib/db-renderer";
import type { CoverTarget, SearchResult, SearchResultAlbum, SearchResultArtist, SearchResultSong } from "@muswag/shared";
import { useNavigate } from "@tanstack/react-router";
import { Autocomplete } from "@base-ui/react/autocomplete";
import type { FuseResult } from "fuse.js";
import { useRef, useState, useTransition } from "react";
import { cn } from "#/lib/utils";
import { useHotkey } from "@tanstack/react-hotkeys";

const InnerResult = ({
  title,
  subtitle,
  coverPath,
  target,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  title?: string;
  subtitle?: string | undefined;
  coverPath?: string | undefined;
  target?: CoverTarget | undefined;
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

const ArtistResult = ({ artist }: { artist: SearchResultArtist["artist"] }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={
        <InnerResult
          title={artist.name}
          coverPath={artist.coverArtPath}
          target={
            artist.id
              ? {
                  type: "artist",
                  id: artist.id,
                  coverArtId: artist.coverArt ?? null,
                }
              : undefined
          }
        />
      }
      onClick={() =>
        n({
          to: "/app/artists/$artistId",
          params: { artistId: artist.id },
          resetScroll: true,
        })
      }
    />
  );
};

const SongResult = ({ song }: { song: SearchResultSong["song"] }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={
        <InnerResult
          title={song.title}
          subtitle={song.artist}
          coverPath={song.coverArtPath}
          target={
            song.albumId
              ? {
                  type: "album",
                  id: song.albumId,
                  coverArtId: song.coverArt ?? null,
                }
              : undefined
          }
        />
      }
      onClick={() =>
        n({
          to: "/app/albums/$albumId",
          params: { albumId: song.albumId ?? "n" },
          resetScroll: true,
        })
      }
    />
  );
};

const AlbumResult = ({ album }: { album: SearchResultAlbum["album"] }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={
        <InnerResult
          title={album.name}
          subtitle={album.artist}
          coverPath={album.coverArtPath}
          target={{
            type: "album",
            id: album.id,
            coverArtId: album.coverArt ?? null,
          }}
        />
      }
      onClick={() =>
        n({
          to: "/app/albums/$albumId",
          params: { albumId: album.id },
          resetScroll: true,
        })
      }
    />
  );
};

export function MiniSearch() {
  const [searchValue, setSearchValue] = useState("");
  const [searchResults, setSearchResults] = useState<FuseResult<SearchResult>[]>([]);

  const [isPending, startTransition] = useTransition();

  const abortControllerRef = useRef<AbortController | null>(null);

  const [open, setOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);

  useHotkey("Mod+F", () => inputRef.current?.focus());
  useHotkey("Escape", () => inputRef.current?.blur(), { target: inputRef });

  return (
    <Autocomplete.Root
      open={open}
      onOpenChange={setOpen}
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
          const result = await FuzeSearch.search(nextSearchValue, {
            limit: 20,
          });
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
        ref={inputRef}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        placeholder="Search..."
        className="relative z-20 h-full w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
      />

      <Autocomplete.Portal>
        <Autocomplete.Positioner className="z-20 outline-hidden" sideOffset={4} align="start">
          <Autocomplete.Popup className="w-(--anchor-width) max-w-(--available-width) rounded-md bg-background px-1 shadow-2xl" aria-busy={isPending || undefined}>
            <div className="max-h-[min(var(--available-height),22.5rem)] scroll-pt-1 scroll-pb-1 overflow-y-auto overscroll-contain">
              <Autocomplete.List>
                {(v: FuseResult<SearchResult>) => {
                  if (v.item.type === "song") return <SongResult key={v.item.id} song={v.item.song} />;
                  if (v.item.type === "album") return <AlbumResult key={v.item.id} album={v.item.album} />;
                  if (v.item.type === "artist") return <ArtistResult key={v.item.id} artist={v.item.artist} />;
                  return;
                }}
              </Autocomplete.List>
            </div>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
