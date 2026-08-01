import { MiniSearch } from "#/components/search";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

const NavButtons = () => {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const canGoForward = router.history.location.state.__TSR_index < router.history.length - 1;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Go back"
        disabled={!canGoBack}
        onClick={() => {
          router.history.back();
        }}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Go forward"
        disabled={!canGoForward}
        onClick={() => {
          router.history.forward();
        }}
      >
        <ChevronRight className="size-4" />
      </Button>
    </>
  );
};

export const TopBar = () => {
  const isMac = navigator.userAgent.toUpperCase().includes("MAC");

  return (
    <div className={cn("h-(--top-height) absolute top-0 z-10  w-full  flex items-center ")}>
      <div className="app-drag-region shrink-0  h-full w-30"></div>
      <div className="app-drag-region  w-full h-full"></div>
      <MiniSearch />
      <div className="app-drag-region  w-full h-full"></div>
      <div className="app-drag-region shrink-0 w-20 h-full"></div>{" "}
      <div className="absolute w-full h-full backdrop-blur-sm bg-background/30 [-webkit-mask-image:linear-gradient(to_bottom,black_20%,transparent_100%)]"></div>
    </div>
  );
};
