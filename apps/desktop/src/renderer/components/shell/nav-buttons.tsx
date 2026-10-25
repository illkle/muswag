import { Button } from "#/components/ui/button";
import { useCanGoBack, useLocation, useRouter } from "@tanstack/react-router";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";

export const NavButtons = () => {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  // Read through the location's subscription: the history is no store, so reading it while rendering would leave
  // the button as it was when something else last re-rendered it. Every change of the history's length comes
  // with a new location.
  const canGoForward = useLocation({ select: (location) => location.state.__TSR_index < router.history.length - 1 });

  return (
    <div className="flex">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Go back"
        disabled={!canGoBack}
        onClick={() => {
          router.history.back();
        }}
      >
        <CaretLeftIcon weight="fill" className="size-4" />
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
        <CaretRightIcon weight="fill" className="size-4" />
      </Button>
    </div>
  );
};
