import { useStore } from "@tanstack/react-store";

import { glowSettings } from "#/library/cover-palette";
import type { CoverPalette, Rgb } from "#shared/cover-palette";

/**
 * The rings of the cover's colours, all centred on it, widest first and drawn under the next: the second glow
 * colour widest and faintest, the first inside it, the accent closest to the cover and strongest. `size` is the
 * ring's width as a share of the cover's edge, `alpha` its alpha at the centre.
 */
const RINGS = [
  { colour: "second", size: 2.7, alpha: 0.35 },
  { colour: "first", size: 2, alpha: 0.5 },
  { colour: "accent", size: 1.45, alpha: 0.75 },
] as const;

/** How far the glow may reach past each edge of the cover, as shares of its edge: room for the widest ring at the largest size. */
const REACH = 3;
/** Over how many pixels the glow fades out before an edge the page cuts it at. */
const EDGE_FADE = 40;

/**
 * The cover's three colours glowing behind it in rings. Placed before the cover in a positioned parent of the
 * cover's size; the rings are sized to the cover, so they fit any. `strength` scales the
 * alphas: lower for a small cover. `room` is how many pixels there are above and left of the cover before the
 * page cuts what is drawn: the glow fades out before there rather than ending in a straight edge.
 */
export function CoverGlow({ palette, strength = 1, room }: { palette: CoverPalette | null; strength?: number; room?: { top: number; left: number } }) {
  const settings = useStore(glowSettings);
  const accent = palette?.accent;
  // A grey cover has no accent, and nothing to glow in.
  if (!palette || !accent) return null;

  // A cover of one colour glows in it alone: its rings for the glow colours take the accent, fainter.
  const colours = { accent, first: palette.glow[0], second: palette.glow[1] };
  // Where the cover starts in the glow's box, which reaches `REACH` covers past it on every side.
  const coverStart = `${(REACH / (2 * REACH + 1)) * 100}%`;
  const fadeIn = (direction: string, edge: number) => `linear-gradient(${direction}, transparent calc(${coverStart} - ${edge}px), black calc(${coverStart} - ${edge - EDGE_FADE}px))`;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        inset: `-${REACH * 100}%`,
        ...(room ? { maskImage: `${fadeIn("to right", room.left)}, ${fadeIn("to bottom", room.top)}`, maskComposite: "intersect" } : {}),
      }}
    >
      <div className="absolute" style={{ inset: coverStart }}>
        {RINGS.map((ring) => {
          const colour = colours[ring.colour];
          const alpha = ring.alpha * (colour ? 1 : 0.6) * settings.intensity * strength;
          return (
            <div
              key={ring.colour}
              className="absolute top-1/2 left-1/2 -translate-1/2 animate-in fade-in-0 duration-700"
              style={{
                width: `${ring.size * settings.size * 100}%`,
                height: `${ring.size * settings.size * 100}%`,
                background: `radial-gradient(closest-side, ${fade(colour ?? accent, alpha, settings.softness)})`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Stops for a radial gradient that fades from `alpha` at its centre to nothing at its edge along a curve: two
 * stops fade in a straight line, which leaves a visible edge and bands. A softer one falls off sooner and
 * spreads its colour thinner.
 */
function fade(colour: Rgb, alpha: number, softness: number) {
  const { r, g, b } = colour;
  const steps = 8;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${(Math.min(1, alpha) * (1 - t) ** (0.5 + softness)).toFixed(3)}) ${(t * 100).toFixed(1)}%`;
  }).join(", ");
}
