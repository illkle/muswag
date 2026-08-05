import { DialogContent, DialogTrigger, Dialog } from "#/components/ui/dialog";
import type { ReactNode } from "react";

export const DebugModal = ({ children }: { children: ReactNode }) => {
  return (
    <Dialog>
      <DialogContent>{children}</DialogContent>
      <DialogTrigger className={"absolute top-8 right-16 z-1000 bg-primary text-secondary opacity-35"}>Debug</DialogTrigger>
    </Dialog>
  );
};
