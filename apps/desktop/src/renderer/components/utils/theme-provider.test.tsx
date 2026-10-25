// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, useTheme, type Theme } from "#/components/utils/theme-provider";
import { appCommand } from "#/data/app-command";

vi.mock("#/data/app-command", () => ({ appCommand: vi.fn(async () => undefined) }));

/** The OS setting, as `matchMedia` reports it and announces its changes. */
const system = {
  dark: false,
  listeners: new Set<() => void>(),
  set(dark: boolean) {
    this.dark = dark;
    for (const listener of this.listeners) listener();
  },
};

let setTheme: (theme: Theme) => void;
const Probe = () => {
  setTheme = useTheme().setTheme;
  return null;
};

const classes = () => [...document.documentElement.classList].sort();

beforeEach(() => {
  vi.mocked(appCommand).mockClear();
  system.dark = false;
  system.listeners.clear();
  localStorage.clear();
  document.documentElement.className = "";
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return system.dark;
    },
    addEventListener: (_type: string, listener: () => void) => system.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => system.listeners.delete(listener),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderProvider = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

describe("ThemeProvider", () => {
  it("follows the OS while the theme is System, when the OS changes as well as at launch", () => {
    renderProvider();
    expect(classes()).toEqual(["light"]);

    act(() => system.set(true));
    expect(classes()).toEqual(["dark"]);

    act(() => system.set(false));
    expect(classes()).toEqual(["light"]);
  });

  it("stops following the OS once a theme is chosen, and keeps the choice", () => {
    renderProvider();

    act(() => setTheme("light"));
    act(() => system.set(true));

    expect(classes()).toEqual(["light"]);
    expect(localStorage.getItem("vite-ui-theme")).toBe("light");
    expect(system.listeners.size).toBe(0);
  });

  it("starts from the stored choice", () => {
    localStorage.setItem("vite-ui-theme", "dark");

    renderProvider();

    expect(classes()).toEqual(["dark"]);
  });

  it("has the window drawn in the theme chosen, or the OS's while it is System", () => {
    renderProvider();
    act(() => setTheme("dark"));
    act(() => setTheme("system"));

    expect(vi.mocked(appCommand).mock.calls).toEqual([
      ["window:setTheme", "system"],
      ["window:setTheme", "dark"],
      ["window:setTheme", "system"],
    ]);
  });
});
