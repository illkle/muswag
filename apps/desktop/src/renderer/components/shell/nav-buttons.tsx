import { Button } from "#/components/ui/button";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";

export const NavButtons = () => {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const canGoForward = router.history.location.state.__TSR_index < router.history.length - 1;

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
        <CaretLeftIcon className="size-4" />
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
        <CaretRightIcon className="size-4" />
      </Button>
    </div>
  );
};
