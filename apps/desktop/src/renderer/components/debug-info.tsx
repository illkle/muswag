import { DialogContent, DialogTrigger, Dialog } from '#/components/ui/dialog';
import type { JSX, ReactNode } from 'react';

export const DebugModal = ({ children }: { children: ReactNode }) => {
  return (
    <Dialog>
      <DialogContent>{children}</DialogContent>
      <DialogTrigger
        className={
          'absolute top-8 right-16 opacity-35 bg-primary text-secondary z-1000'
        }
      >
        Debug
      </DialogTrigger>
    </Dialog>
  );
};
