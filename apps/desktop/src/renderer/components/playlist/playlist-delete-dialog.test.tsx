// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlaylistDeleteDialog } from "#/components/playlist/playlist-delete-dialog";

afterEach(cleanup);

function renderDialog(onConfirm = vi.fn(async () => undefined)) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <PlaylistDeleteDialog open onOpenChange={onOpenChange} playlistName="Road trip" onConfirm={onConfirm} onDeleted={onDeleted} />
    </QueryClientProvider>,
  );

  return { onConfirm, onDeleted, onOpenChange };
}

describe("PlaylistDeleteDialog", () => {
  it("does not delete until the destructive action is confirmed", async () => {
    const handlers = renderDialog();

    expect(screen.getByText(/Road trip/)).toBeTruthy();
    expect(handlers.onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete playlist" }));

    await waitFor(() => expect(handlers.onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handlers.onDeleted).toHaveBeenCalledTimes(1));
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open and reports a deletion failure", async () => {
    const handlers = renderDialog(vi.fn(async () => Promise.reject(new Error("server refused"))));

    fireEvent.click(screen.getByRole("button", { name: "Delete playlist" }));

    await waitFor(() => expect(screen.getByText("server refused")).toBeTruthy());
    expect(handlers.onDeleted).not.toHaveBeenCalled();
    expect(handlers.onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
