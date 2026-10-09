import { cn } from "#/lib/utils";

/**
 * A range input drawn as a thin track filled up to its value, with a thumb that shows on hover.
 * It stays a native input, so its events and its keyboard handling are the browser's.
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  className,
  style,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "value" | "min" | "max"> & { value: number; min?: number; max?: number }) {
  const fill = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;

  return <input type="range" min={min} max={max} value={value} className={cn("slider", className)} style={{ "--slider-fill": fill, ...style } as React.CSSProperties} {...props} />;
}
