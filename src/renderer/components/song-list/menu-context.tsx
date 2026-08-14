import { Menu, MenuContent } from "#/components/ui/menu";
import { createContext, type ReactNode } from "react";

export const SongListMenuContext = createContext<{ open: () => void } | null>(null);

export const SongListMenuWrapper = ({ children, menuContent }: { children: ReactNode; menuContent: ReactNode }) => {
  return (
    <Menu>
      <MenuContent>{menuContent}</MenuContent>
      {children}
    </Menu>
  );
};
