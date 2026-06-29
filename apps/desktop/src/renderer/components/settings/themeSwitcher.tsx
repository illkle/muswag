import { RadioTabs, RadioTabItem } from "#/components/custom/radio-tabs";
import { useTheme, type Theme } from "#/components/theme-provider";
import { cn } from "#/lib/utils";
import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react";
import { useIsClient } from "usehooks-ts";

export const ThemeSwitcher = ({ className }: { className?: string }) => {
  const { theme, setTheme } = useTheme();
  const isClient = useIsClient();

  return (
    <RadioTabs
      value={isClient ? theme || "system" : null}
      defaultValue={theme || "system"}
      onValueChange={(v) => setTheme(v as Theme)}
      className={cn("h-8 w-fit p-0.5", className)}
    >
      <RadioTabItem value="light" id="light" className="w-full">
        <SunIcon size={16} />
      </RadioTabItem>
      <RadioTabItem value="system" id="system" className="w-full">
        <LaptopIcon size={16} />
      </RadioTabItem>
      <RadioTabItem value="dark" id="dark" className="w-full">
        <MoonIcon size={16} />
      </RadioTabItem>
    </RadioTabs>
  );
};
