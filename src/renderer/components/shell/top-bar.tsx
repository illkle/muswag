import { MiniSearch } from "#/components/search";
import { cn } from "#/lib/utils";

export const TopBar = () => {
  //const isMac = navigator.userAgent.toUpperCase().includes("MAC");

  return (
    <div className={cn("absolute top-0 z-10 mr-6 flex h-(--top-height) w-full items-center")}>
      <div className="app-drag-region h-full grow"></div>
      <div className="w-1/3">
        <MiniSearch />
      </div>
      <div className="app-drag-region h-full grow"></div>
      <div className="absolute h-full w-full bg-background [-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_100%)]"></div>
    </div>
  );
};
