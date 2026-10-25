import { createStore, useSelector } from "@tanstack/react-store";

const STORAGE_KEY = "muswag-setup-done";

/**
 * Whether this computer has been through setup: mpv worked, or the user chose to go on without it.
 * Until then the app waits behind the setup page. mpv belongs to the computer, not to an account, so
 * logging out does not undo it.
 */
const setupDone = createStore(localStorage.getItem(STORAGE_KEY) === "true");

export const useSetupDone = () => useSelector(setupDone);

export function finishSetup() {
  localStorage.setItem(STORAGE_KEY, "true");
  setupDone.setState(() => true);
}
