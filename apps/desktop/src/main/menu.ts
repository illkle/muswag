import { Menu, type MenuItemConstructorOptions } from "electron";
import { is } from "@electron-toolkit/utils";

/**
 * The application menu. Electron's default one zooms in on Cmd/Ctrl+Plus only, which takes Shift on most
 * layouts, so Cmd/Ctrl+= is bound too, as browsers bind it. The rest is what macOS expects of an app: its
 * Edit menu is what makes copy and paste work in text fields there.
 */
export function setApplicationMenu(): void {
  const isMac = process.platform === "darwin";

  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      ...(is.dev ? ([{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }] satisfies MenuItemConstructorOptions[]) : []),
      { role: "resetZoom" },
      { role: "zoomIn", accelerator: "CommandOrControl+=" },
      // Plus too, which is a key of its own on some layouts and Shift+= on others.
      { role: "zoomIn", accelerator: "CommandOrControl+Plus", visible: false },
      { role: "zoomOut" },
      ...(isMac ? ([{ type: "separator" }, { role: "togglefullscreen" }] satisfies MenuItemConstructorOptions[]) : []),
    ],
  };

  Menu.setApplicationMenu(Menu.buildFromTemplate(isMac ? [{ role: "appMenu" }, { role: "editMenu" }, view, { role: "windowMenu" }] : [view]));
}
