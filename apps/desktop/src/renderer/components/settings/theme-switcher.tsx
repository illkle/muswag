import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react";

import { MenuRadioGroup, MenuRadioItem } from "#/components/ui/menu";
import { useTheme, type Theme } from "#/components/utils/theme-provider";
import { cn } from "#/lib/utils";

const themeOptions: { icon: typeof SunIcon; label: string; value: Theme }[] = [
  { icon: SunIcon, label: "Light", value: "light" },
  { icon: LaptopIcon, label: "System", value: "system" },
  { icon: MoonIcon, label: "Dark", value: "dark" },
];

/**
 * Segmented theme control built from menu radio items, so arrow keys still walk it
 * like the rest of the menu while the pointer sees a single compact switch.
 */
export const ThemeMenuControl = ({ className }: { className?: string }) => {
  const { setTheme, theme } = useTheme();

  return (
    <MenuRadioGroup
      className={cn("flex gap-0.5 rounded-md bg-muted p-0.5", className)}
      onValueChange={(value) => setTheme(value as Theme)}
      value={theme || "system"}
    >
      {themeOptions.map(({ icon: Icon, label, value }) => (
        <MenuRadioItem
          aria-label={label}
          className="flex-1 justify-center rounded-[calc(var(--radius-md)-2px)] px-0 py-1 text-muted-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-checked:bg-background data-checked:text-foreground data-checked:shadow-sm data-checked:data-highlighted:bg-background data-checked:data-highlighted:text-foreground"
          key={value}
          value={value}
        >
          <Icon className="size-4" />
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
};
