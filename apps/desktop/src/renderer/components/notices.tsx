import { Toast } from "@base-ui/react/toast";
import { WarningIcon, XIcon } from "@phosphor-icons/react";

import { notices } from "#/lib/notify";

/**
 * Shows what `notifyFailure` reports, each for a few seconds, under the top bar of the column this
 * is placed in.
 */
export function Notices() {
  return (
    <Toast.Provider toastManager={notices}>
      <Toast.Viewport className="pointer-events-none absolute top-(--top-height) left-1/2 z-50 flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4 pt-1">
        <NoticeList />
      </Toast.Viewport>
    </Toast.Provider>
  );
}

function NoticeList() {
  const { toasts } = Toast.useToastManager();

  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      // A notice is read and dismissed, not dragged away.
      swipeDirection={[]}
      className="pointer-events-auto flex max-w-full items-center gap-3 rounded-lg surface-raised px-3 py-1.5 text-sm transition-opacity duration-200 data-ending-style:opacity-0 data-limited:hidden data-starting-style:opacity-0"
    >
      <WarningIcon weight="fill" className="size-4 shrink-0 text-destructive" />
      <Toast.Content className="min-w-0 py-1.5">
        <Toast.Title className="line-clamp-2" />
        <Toast.Description className="line-clamp-2 text-xs text-muted-foreground" />
      </Toast.Content>
      <Toast.Close aria-label="Dismiss" className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground">
        <XIcon className="size-3.5" />
      </Toast.Close>
    </Toast.Root>
  ));
}
