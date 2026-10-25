// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listeners: new Set<(event: { tables: Record<string, unknown> }) => void>() }));
vi.mock("./library-changes", () => ({
  onLibraryChange: (listener: (event: { tables: Record<string, unknown> }) => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

const { invalidateTables, queryClient, useMainRead } = await import("./main-read");

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
const changed = (...tables: string[]) => {
  for (const listener of mocks.listeners) listener({ tables: Object.fromEntries(tables.map((table) => [table, null])) });
};

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("useMainRead", () => {
  it("reads again when a table it depends on changes, and not for another", async () => {
    let reads = 0;
    const { result } = renderHook(() => useMainRead({ queryKey: ["test-album"], tables: ["albums", "songs"], read: async () => ++reads }), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(1));

    act(() => changed("artists"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads).toBe(1);

    act(() => changed("songs"));
    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it("reads once for a burst of changes", async () => {
    let reads = 0;
    const { result } = renderHook(() => useMainRead({ queryKey: ["test-burst"], tables: ["songs"], read: async () => ++reads }), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(1));
    // Let the last refresh's interval pass, so the next change is read at once.
    await new Promise((resolve) => setTimeout(resolve, 300));

    act(() => {
      for (let index = 0; index < 20; index++) changed("songs");
    });
    await waitFor(() => expect(result.current.data).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads).toBe(2);
  });

  it("reads again a first read that a change came during, which may have been read before it", async () => {
    let reads = 0;
    let answerFirst: (value: string) => void = () => {};
    const read = () => (++reads === 1 ? new Promise<string>((resolve) => (answerFirst = resolve)) : Promise.resolve("after"));
    const { result } = renderHook(() => useMainRead({ queryKey: ["test-race"], tables: ["songs"], read }), { wrapper });
    await waitFor(() => expect(reads).toBe(1));

    act(() => changed("songs"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    answerFirst("before");

    await waitFor(() => expect(result.current.data).toBe("after"));
    expect(reads).toBe(2);
  });

  it("resolves invalidateTables only once the newest read is in, when another invalidation cancels its read", async () => {
    let reads = 0;
    const answers: Array<(value: number) => void> = [];
    const read = () => (++reads === 1 ? Promise.resolve(0) : new Promise<number>((resolve) => answers.push(resolve)));
    const { result } = renderHook(() => useMainRead({ queryKey: ["test-settle"], tables: ["playlists"], read }), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(0));

    let settled = false;
    const first = invalidateTables(["playlists"]).then(() => (settled = true));
    await waitFor(() => expect(answers).toHaveLength(1));
    // Another invalidation, as the change main sends makes, cancels the read the first started.
    void invalidateTables(["playlists"]);
    await waitFor(() => expect(answers).toHaveLength(2));
    answers[0]!(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    answers[1]!(2);
    await first;
    expect(queryClient.getQueryData(["test-settle"])).toBe(2);
  });

  it("reads a quiet read again only once the library has stopped changing", async () => {
    let quietReads = 0;
    let quickReads = 0;
    const { result } = renderHook(
      () => ({
        quiet: useMainRead({ queryKey: ["test-quiet"], tables: ["songs"], read: async () => ++quietReads, quiet: true }),
        quick: useMainRead({ queryKey: ["test-quick"], tables: ["songs"], read: async () => ++quickReads }),
      }),
      { wrapper },
    );
    await waitFor(() => expect([result.current.quiet.data, result.current.quick.data]).toEqual([1, 1]));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A sync's changes, one every 200 ms for 800 ms.
    for (let index = 0; index < 5; index++) {
      act(() => changed("songs"));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(quickReads).toBeGreaterThan(2);
    expect(quietReads).toBe(1);

    await waitFor(() => expect(result.current.quiet.data).toBe(2), { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(quietReads).toBe(2);
  });

  it("keeps the rows that came back the same as the same objects", async () => {
    let title = "One";
    const { result } = renderHook(() => useMainRead({ queryKey: ["test-rows"], tables: ["songs"], read: async () => [{ id: "a" }, { id: "b", title }] }), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    const [first, second] = result.current.data!;

    title = "Two";
    await act(() => invalidateTables(["songs"]));
    await waitFor(() => expect(result.current.data![1]).toEqual({ id: "b", title: "Two" }));
    expect(result.current.data![0]).toBe(first);
    expect(second).toEqual({ id: "b", title: "One" });
  });
});
