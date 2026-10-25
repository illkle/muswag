import { AlbumCover } from "#/components/album-list/album-cover";
import { TrackCover } from "#/components/track-list/columns";
import { LibraryActions } from "#/library/actions";
import type { SearchResult } from "@muswag/model";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "#/lib/utils";
import { useHotkey } from "@tanstack/react-hotkeys";
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";

type Found<Type extends SearchResult["type"]> = Extract<SearchResult, { type: Type }>;

const InnerResult = ({
  kind,
  title,
  subtitle,
  cover,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  /** What the result is, since an artist, an album and a song can share a name. */
  kind: string;
  title?: string;
  subtitle?: string | null | undefined;
  cover: ReactNode;
}) => {
  return (
    <div className={cn("flex h-12 items-center gap-2.5 rounded-sm px-2 data-highlighted:bg-accent", className)} {...props}>
      <div className="w-10 shrink-0">{cover}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">{kind}</div>
    </div>
  );
};

const ArtistResult = ({ artist }: { artist: Found<"artist">["artist"] }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={
        <InnerResult kind="Artist" title={artist.name} cover={<AlbumCover size="icon" className="rounded-full" target={{ type: "artist", id: artist.id, coverArtId: artist.coverArt ?? null }} />} />
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

const SongResult = ({ song }: { song: Found<"song">["song"] }) => {
  const n = useNavigate();
  const { albumId, artistId } = song;
  return (
    <Autocomplete.Item
      // The cover is the album's, which is read here rather than kept with every song of the index.
      render={
        <InnerResult kind="Song" title={song.title} subtitle={song.artist} cover={albumId ? <TrackCover albumId={albumId} /> : <AlbumCover size="icon" />} className="data-disabled:opacity-50" />
      }
      // A song the server files under no album leads to its artist instead, and one with neither has no page to open.
      disabled={!albumId && !artistId}
      onClick={() => {
        if (albumId) n({ to: "/app/albums/$albumId", params: { albumId }, resetScroll: true });
        else if (artistId) n({ to: "/app/artists/$artistId", params: { artistId }, resetScroll: true });
      }}
    />
  );
};

const AlbumResult = ({ album }: { album: Found<"album">["album"] }) => {
  const n = useNavigate();
  return (
    <Autocomplete.Item
      render={<InnerResult kind="Album" title={album.name} subtitle={album.artist} cover={<AlbumCover size="icon" target={{ type: "album", id: album.id, coverArtId: album.coverArt ?? null }} />} />}
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

/** How the shortcut that focuses the search reads on this platform. */
const SEARCH_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘F" : "Ctrl F";

export function MiniSearch() {
  const [searchValue, setSearchValue] = useState("");
  // Main searches, behind the typing: the field shows each key at once, and the results of the last
  // search stay until the next one's arrive.
  const { data } = useQuery({
    queryKey: ["search", searchValue],
    queryFn: async () => ({ query: searchValue, results: await LibraryActions.search(searchValue, 20) }),
    enabled: searchValue !== "",
    placeholderData: keepPreviousData,
    // Every search is asked of main again: the library may have changed since.
    gcTime: 0,
  });
  // A search that a later one took the place of answers with nothing, and the one before it stays.
  const [shown, setShown] = useState<{ query: string; results: SearchResult[] }>({ query: "", results: [] });
  if (data?.results && data.results !== shown.results) setShown({ query: data.query, results: data.results });
  const query = searchValue ? shown.query : "";
  const results = searchValue ? shown.results : [];

  const [open, setOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const clear = () => setSearchValue("");

  useHotkey("Mod+F", () => inputRef.current?.focus());
  useHotkey(
    "Escape",
    () => {
      clear();
      inputRef.current?.blur();
    },
    { target: inputRef },
  );

  return (
    <Autocomplete.Root
      // Closed until there are results for what is in the field, so "no results" is not shown ahead of them.
      open={open && searchValue !== "" && query !== ""}
      onOpenChange={setOpen}
      items={results}
      value={searchValue}
      openOnInputClick
      onValueChange={(nextSearchValue, { reason }) => {
        // Picking a result goes to it, which leaves nothing to keep searching for.
        if (reason === "item-press") {
          clear();
          inputRef.current?.blur();
          return;
        }

        setSearchValue(nextSearchValue);
      }}
      itemToStringValue={(item) => item.id}
      filter={null}
    >
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-3 z-30 size-4 -translate-y-1/2 text-muted-foreground" />
        <Autocomplete.Input
          ref={inputRef}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          placeholder="Search"
          className="relative z-20 h-8 w-full min-w-0 rounded-lg bg-popover pr-12 pl-9 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 transition-shadow outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        />
        {searchValue ? (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute top-1/2 right-2 z-30 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            // Keeps the focus in the field, so the next keys go on searching.
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
          >
            <XIcon className="size-3" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-3 z-30 -translate-y-1/2 font-sans text-xs text-muted-foreground">{SEARCH_SHORTCUT}</kbd>
        )}
      </div>

      <Autocomplete.Portal>
        <Autocomplete.Positioner className="z-20 outline-hidden" sideOffset={4} align="start">
          <Autocomplete.Popup className="w-(--anchor-width) max-w-(--available-width) rounded-lg surface-raised p-1" aria-busy={query !== searchValue || undefined}>
            <div className="max-h-[min(var(--available-height),22.5rem)] overflow-y-auto overscroll-contain">
              <Autocomplete.Empty className="px-2 py-3 text-center text-sm text-muted-foreground empty:hidden">No results for “{query}”</Autocomplete.Empty>
              <Autocomplete.List>
                {(result: SearchResult) => {
                  const key = `${result.type}:${result.id}`;
                  if (result.type === "song") return <SongResult key={key} song={result.song} />;
                  if (result.type === "album") return <AlbumResult key={key} album={result.album} />;
                  return <ArtistResult key={key} artist={result.artist} />;
                }}
              </Autocomplete.List>
            </div>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
