/**
 * The rings of the cover's colours, all centred on it, widest first and drawn under the next: the second glow
 * colour widest and faintest, the first inside it, the accent closest to the cover and strongest. `size` is the
 * ring's width as a share of the cover's edge, `alpha` its alpha at the centre.
 */
const RINGS = [
  { colour: "--cover-glow-2", size: 2.7, alpha: 0.35 },
  { colour: "--cover-glow-1", size: 2, alpha: 0.5 },
  { colour: "--cover-accent", size: 1.45, alpha: 0.75 },
] as const;

/** How far the glow reaches past each edge of the cover, as shares of its edge: room for the widest ring. */
const REACH = 1;
/** Over how many pixels the glow fades out before an edge the page cuts it at. */
const EDGE_FADE = 40;

/**
 * The colours of the cover glowing behind it in rings, from the custom properties `CoverColoursScope` sets:
 * nothing shows for a cover without colours. Placed before the cover in a positioned parent of the cover's
 * size; the rings are sized to the cover, so they fit any. `strength` scales their alphas: lower for a small
 * cover. `room` is how many pixels there are above and left of the cover before the page cuts what is drawn:
 * the glow fades out before there rather than ending in a straight edge.
 */
export function CoverGlow({ strength = 1, room }: { strength?: number; room?: { top: number; left: number } }) {
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
        {RINGS.map((ring) => (
          <div
            key={ring.colour}
            className="absolute top-1/2 left-1/2 -translate-1/2"
            style={{ width: `${ring.size * 100}%`, height: `${ring.size * 100}%`, background: `radial-gradient(closest-side, ${fade(ring.colour, ring.alpha * strength)})` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Stops for a radial gradient that fades the colour of a custom property from `alpha` at its centre to nothing
 * at its edge along an ease-out curve: two stops fade in a straight line, which leaves a visible edge and bands.
 */
function fade(property: string, alpha: number) {
  const steps = 8;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return `color-mix(in srgb, var(${property}) ${(Math.min(1, alpha) * (1 - t) ** 1.5 * 100).toFixed(1)}%, transparent) ${(t * 100).toFixed(1)}%`;
  }).join(", ");
}
