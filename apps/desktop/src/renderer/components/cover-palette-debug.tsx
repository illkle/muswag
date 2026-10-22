import { PaletteIcon, XIcon } from "@phosphor-icons/react";
import { useStore } from "@tanstack/react-store";

import { Button } from "#/components/ui/button";
import { Slider } from "#/components/ui-custom/slider";
import { DEFAULT_GLOW_SETTINGS, glowSettings, paletteDebug, setGlowSettings, setPaletteDebug, useCoverPalette, type GlowSettings } from "#/library/cover-palette";
import { cn } from "#/lib/utils";
import { toCss, toHex, type Rgb } from "#shared/cover-palette";
import type { CoverTarget } from "@muswag/model";

/** Development only: what was taken from a cover, drawn over it while the debug panel is open. */
export function CoverPaletteSwatches({ target }: { target: CoverTarget }) {
  const palette = useCoverPalette(target);
  if (!palette) return null;

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 bg-black/55 p-1 text-[10px] leading-none text-white backdrop-blur-sm">
      {/* The colours the cover was reduced to, as wide as their share of it. */}
      <div className="flex h-2 overflow-hidden rounded-sm">
        {palette.colours.map(({ colour, share }, index) => (
          <div key={index} title={`${toHex(colour)} · ${pct(share)} of cover`} className="h-full" style={{ backgroundColor: toCss(colour), flexGrow: share }} />
        ))}
      </div>
      <div className="flex items-center gap-1">
        {palette.accent ? <Swatch colour={palette.accent} title={`accent ${toHex(palette.accent)}`} label="A" /> : <span title="too grey: the accent is the text colour">grey</span>}
        <span className="mx-0.5 opacity-50">|</span>
        {palette.glow.map((colour, index) =>
          colour ? (
            <Swatch key={index} colour={colour} title={`glow ${index + 1} ${toHex(colour)}`} label={String(index + 1)} />
          ) : (
            <span key={index} title={`no glow ${index + 1}: the cover has no other colour of a hue of its own`} className="opacity-50">
              –
            </span>
          ),
        )}
      </div>
    </div>
  );
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

function Swatch({ colour, title, label }: { colour: Rgb; title: string; label: string }) {
  return (
    <div title={title} className="flex size-5 shrink-0 items-center justify-center rounded-sm ring-1 ring-white/40" style={{ backgroundColor: toCss(colour) }}>
      <span className="font-semibold mix-blend-difference">{label}</span>
    </div>
  );
}

const CONTROLS: ReadonlyArray<{ key: keyof GlowSettings; label: string }> = [
  { key: "size", label: "Size" },
  { key: "softness", label: "Softness" },
  { key: "intensity", label: "Intensity" },
];

/** Development only: a floating panel for tuning how the cover's colours are drawn, which also draws them over every cover. */
export function CoverPaletteDebug() {
  const open = useStore(paletteDebug);
  const settings = useStore(glowSettings);

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="fixed top-12 right-4 z-50 gap-1.5 opacity-60 hover:opacity-100" onClick={() => setPaletteDebug(true)}>
        <PaletteIcon className="size-4" />
        Cover colours
      </Button>
    );
  }

  const changed = Object.fromEntries(Object.entries(settings).filter(([key, value]) => DEFAULT_GLOW_SETTINGS[key as keyof GlowSettings] !== value));

  return (
    <div className="scrollbar scrollbar-slim scrollbar-flush fixed top-12 right-4 z-50 flex max-h-[calc(100vh-var(--top-height)-var(--player-height)-1.5rem)] w-72 flex-col gap-3 overflow-y-auto rounded-lg surface-raised p-3 text-xs">
      <div className="flex items-center gap-1">
        <span className="grow text-sm font-semibold">Cover colours</span>
        <Button size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(JSON.stringify(changed, null, 2))} title="Copy the settings that differ from the defaults">
          Copy
        </Button>
        <Button size="xs" variant="outline" onClick={() => setGlowSettings(null)} disabled={Object.keys(changed).length === 0}>
          Reset
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={() => setPaletteDebug(false)} aria-label="Close">
          <XIcon />
        </Button>
      </div>

      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium text-muted-foreground">Glow behind the album page's cover</h3>
        {CONTROLS.map(({ key, label }) => (
          <label key={key} className="flex flex-col">
            <span className="flex justify-between">
              <span className={cn(settings[key] !== DEFAULT_GLOW_SETTINGS[key] && "text-brand")}>{label}</span>
              <span className="tabular-nums">×{Number(settings[key].toFixed(2))}</span>
            </span>
            <Slider min={0} max={2.5} step={0.05} value={settings[key]} onChange={(event) => setGlowSettings({ [key]: Number(event.target.value) })} onDoubleClick={() => setGlowSettings({ [key]: DEFAULT_GLOW_SETTINGS[key] })} />
          </label>
        ))}
      </section>
      <p className="text-muted-foreground">Bar: the colours the cover was reduced to. Swatches: accent (A), glow 1 and 2; – where the cover has no colour for one. Sliders scale the glow's rings: their sizes, falloff and alphas; double-click one to reset it.</p>
    </div>
  );
}
