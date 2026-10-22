import { createStore } from "@tanstack/react-store";
import { useCallback, useSyncExternalStore } from "react";

import { toCoverArtUrl } from "#/library/cover-url";
import { coverPalette, foregroundOn, PALETTE_SAMPLE_SIZE, toCss, type CoverPalette } from "#shared/cover-palette";
import type { CoverTarget } from "@muswag/model";

/** How the cover's colours glow behind it. The numbers scale the rings' sizes, falloff and alphas: 1 is as they were designed. */
export interface GlowSettings {
  readonly size: number;
  readonly softness: number;
  readonly intensity: number;
}

export const DEFAULT_GLOW_SETTINGS: GlowSettings = { size: 1, softness: 1, intensity: 1 };

const SETTINGS_KEY = "muswag-cover-glow-settings";
const DEBUG_KEY = "muswag-cover-palette-debug";

function storedSettings(): GlowSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Record<string, unknown> | null;
    // Settings since removed are dropped.
    const known = Object.entries(stored ?? {}).filter(([key, value]) => key in DEFAULT_GLOW_SETTINGS && typeof value === "number");
    return { ...DEFAULT_GLOW_SETTINGS, ...Object.fromEntries(known) };
  } catch {
    return DEFAULT_GLOW_SETTINGS;
  }
}

/** The defaults, unless the debug panel tuned them: what it sets is kept in this window's storage while the glow is being tuned. */
export const glowSettings = createStore<GlowSettings>(storedSettings());

export function setGlowSettings(next: Partial<GlowSettings> | null) {
  glowSettings.setState((settings) => (next ? { ...settings, ...next } : DEFAULT_GLOW_SETTINGS));
  if (next) localStorage.setItem(SETTINGS_KEY, JSON.stringify(glowSettings.state));
  else localStorage.removeItem(SETTINGS_KEY);
}

/** Whether the debug panel is open, and with it the colours drawn over every cover. */
export const paletteDebug = createStore(localStorage.getItem(DEBUG_KEY) === "true");

export function setPaletteDebug(open: boolean) {
  paletteDebug.setState(() => open);
  localStorage.setItem(DEBUG_KEY, String(open));
}

/** The palettes of the covers read, by address. */
const palettes = new Map<string, CoverPalette | null>();
const reading = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
/** Covers read beyond this many push out the ones read first. */
const PALETTES_KEPT = 1000;

async function readPixels(url: string): Promise<Uint8ClampedArray | null> {
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const size = PALETTE_SAMPLE_SIZE;
  const bitmap = await createImageBitmap(await response.blob(), { resizeWidth: size, resizeHeight: size, resizeQuality: "medium" });
  const context = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, size, size).data;
}

function read(url: string) {
  if (reading.has(url)) return;
  reading.add(url);
  void readPixels(url)
    .catch((cause: unknown) => {
      console.warn("[cover-palette] the cover could not be read", url, cause);
      return null;
    })
    .then((data) => {
      reading.delete(url);
      // A cover that is not there yet is asked for again by whatever shows it next.
      if (!data) return;
      palettes.set(url, coverPalette({ data }));
      if (palettes.size > PALETTES_KEPT) palettes.delete(palettes.keys().next().value!);
      listeners.get(url)?.forEach((listener) => listener());
    });
}

/**
 * The colours taken from the cover, or null while it is being read or when there is none. The thumbnail is
 * read, which the grid loads anyway: the icon is too small a JPEG to keep thin coloured lettering vivid.
 */
export function useCoverPalette(target: CoverTarget | null | undefined): CoverPalette | null {
  const url = target?.coverArtId ? toCoverArtUrl(target.type, target.id, target.coverArtId, "thumbnail") : null;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!url) return () => undefined;
      let forUrl = listeners.get(url);
      if (!forUrl) listeners.set(url, (forUrl = new Set()));
      forUrl.add(onChange);
      if (!palettes.has(url)) read(url);
      return () => {
        forUrl.delete(onChange);
        if (forUrl.size === 0) listeners.delete(url);
      };
    },
    [url],
  );
  return useSyncExternalStore(subscribe, () => (url ? (palettes.get(url) ?? null) : null));
}

/**
 * The custom properties that carry the cover's accent to what is inside: `--brand` and its foreground, which
 * the interface already draws its accent with. A cover too grey for an accent, or
 * one not read yet, leaves the accent to the text colour rather than the theme's lime, which belongs to no cover.
 */
export function paletteStyle(palette: CoverPalette | null): React.CSSProperties {
  return (
    palette?.accent
      ? { "--brand": toCss(palette.accent), "--brand-foreground": toCss(foregroundOn(palette.accent)) }
      : { "--brand": "var(--foreground)", "--brand-foreground": "var(--background)" }
  ) as React.CSSProperties;
}
