import { ArrowDownIcon, ArrowUpIcon, CheckIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import type { AlbumSort } from "@muswag/model";
import { useId } from "react";

import { RadioTabItem, RadioTabs } from "#/components/ui-custom/radio-tabs";
import { Button } from "#/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { setAlbumView, TILE_SIZES, useAlbumView, type TileSize } from "#/library/album-view";
import { cn } from "#/lib/utils";

type Order = { sort: AlbumSort; name?: string; descending?: boolean };

/** What the albums page can be sorted by. Year and artist go either way, first as the first order given. */
const SORTS: ReadonlyArray<{ label: string; orders: readonly [Order, ...Order[]] }> = [
  {
    label: "Year",
    orders: [
      { sort: "year-desc", name: "Newest first", descending: true },
      { sort: "year", name: "Oldest first", descending: false },
    ],
  },
  {
    label: "Artist",
    orders: [
      { sort: "artist", name: "A to Z", descending: false },
      { sort: "artist-desc", name: "Z to A", descending: true },
    ],
  },
  { label: "Recently added", orders: [{ sort: "added" }] },
];

const SIZE_NAMES: Record<TileSize, string> = { s: "Small", m: "Medium", l: "Large", xl: "Extra large" };

const SECTION_LABEL = "px-2 pb-1 text-xs font-medium text-muted-foreground";
/** A section of the pill: as high as it, square-cornered within its round ends, with a focus ring inside it. */
const CONTROL = "h-full rounded-none text-muted-foreground hover:text-foreground focus-visible:ring-inset data-popup-open:text-foreground";

/**
 * How the albums page is sorted and how large its covers are, at the top left of the page: a button
 * that opens what to sort by and the size of the covers, and beside it, for an order that goes either
 * way, one that turns it round.
 */
export function AlbumControls({ className }: { className?: string }) {
  const { sort, tileSize } = useAlbumView();
  const sizeLabelId = useId();
  const current = SORTS.find((option) => option.orders.some((order) => order.sort === sort)) ?? SORTS[0]!;
  const at = Math.max(
    0,
    current.orders.findIndex((order) => order.sort === sort),
  );
  const order = current.orders[at]!;
  const reversed = current.orders[(at + 1) % current.orders.length]!;

  return (
    // One pill, drawn as the search field is, with a line between its sections.
    <div className={cn("flex h-8 items-center overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10", className)}>
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="sm" className={cn("gap-1.5", CONTROL)} />}>
          <SlidersHorizontalIcon />
          {current.label}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 gap-3 p-1 pb-3">
          <div className="pt-1.5">
            <p className={SECTION_LABEL}>Sort by</p>
            {SORTS.map((option) => {
              const active = option === current;
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={active}
                  className="flex h-8 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left outline-hidden select-none hover:bg-accent focus-visible:bg-accent"
                  onClick={() => {
                    if (!active) setAlbumView({ sort: option.orders[0].sort });
                  }}
                >
                  <CheckIcon className={cn("size-3.5 shrink-0", !active && "invisible")} />
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-col">
            <span id={sizeLabelId} className={SECTION_LABEL}>
              Cover size
            </span>
            <RadioTabs aria-labelledby={sizeLabelId} className="mx-1 h-8" value={tileSize} onValueChange={(value) => setAlbumView({ tileSize: value as TileSize })}>
              {(Object.keys(TILE_SIZES) as TileSize[]).map((size) => (
                <RadioTabItem key={size} value={size} aria-label={SIZE_NAMES[size]} className="flex-1 uppercase">
                  {size}
                </RadioTabItem>
              ))}
            </RadioTabs>
          </div>
        </PopoverContent>
      </Popover>

      {order.name && reversed !== order ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(CONTROL, "border-l-foreground/10")}
          aria-label={`${order.name}: sort ${reversed.name?.toLowerCase()}`}
          title={order.name}
          onClick={() => setAlbumView({ sort: reversed.sort })}
        >
          {order.descending ? <ArrowDownIcon /> : <ArrowUpIcon />}
        </Button>
      ) : null}
    </div>
  );
}
