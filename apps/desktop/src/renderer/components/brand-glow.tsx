/**
 * Light catching the top-left corner of a control, in the accent `CoverColoursScope` gives it (`.brand-glow`
 * in `styles.css`). Placed first in the control, which has to be `relative` and `isolate`. `scale` is how far
 * the glow reaches, as a share of the most it reaches: lower for a smaller control.
 */
export function BrandGlow({ scale = 1 }: { scale?: number }) {
  return <span aria-hidden className="brand-glow" style={{ "--brand-glow-scale": scale } as React.CSSProperties} />;
}
