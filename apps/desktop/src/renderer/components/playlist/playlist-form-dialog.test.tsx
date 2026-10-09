// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PlaylistDetails } from "@muswag/model";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";

afterEach(cleanup);

const queryClient = () => new QueryClient({ defaultOptions: { mutations: { retry: false } } });

function Dialog({ open = true, initialValues, onSubmit = async () => undefined }: { open?: boolean; initialValues?: PlaylistDetails; onSubmit?: (values: PlaylistDetails) => Promise<unknown> }) {
  return <PlaylistFormDialog open={open} onOpenChange={() => {}} title="Playlist details" submitLabel="Save" initialValues={initialValues} onSubmit={onSubmit} />;
}

const nameField = () => screen.getByLabelText<HTMLInputElement>("Name");
const descriptionField = () => screen.getByLabelText<HTMLTextAreaElement>("Description");

describe("PlaylistFormDialog", () => {
  it("keeps what was typed when a save changes the playlist before failing", async () => {
    const client = queryClient();
    const saved = { name: "Road trip", comment: "", public: false };
    // The name is saved, which changes the playlist the dialog was opened for, and the description is refused.
    const onSubmit = vi.fn(async () => Promise.reject(new Error("The description was refused.")));
    const view = render(
      <QueryClientProvider client={client}>
        <Dialog initialValues={saved} onSubmit={onSubmit} />
      </QueryClientProvider>,
    );

    fireEvent.change(nameField(), { target: { value: "Road trip 2" } });
    fireEvent.change(descriptionField(), { target: { value: "For the drive north" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("The description was refused.")).toBeTruthy());

    view.rerender(
      <QueryClientProvider client={client}>
        <Dialog initialValues={{ ...saved, name: "Road trip 2" }} onSubmit={onSubmit} />
      </QueryClientProvider>,
    );

    expect(nameField().value).toBe("Road trip 2");
    expect(descriptionField().value).toBe("For the drive north");
  });

  it("starts from the playlist as it is each time it opens", async () => {
    const client = queryClient();
    const dialog = (open: boolean, name: string) => (
      <QueryClientProvider client={client}>
        <Dialog open={open} initialValues={{ name, comment: "", public: false }} />
      </QueryClientProvider>
    );
    const view = render(dialog(true, "Road trip"));

    fireEvent.change(nameField(), { target: { value: "Abandoned" } });
    view.rerender(dialog(false, "Road trip"));
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
    view.rerender(dialog(true, "Renamed elsewhere"));

    expect(nameField().value).toBe("Renamed elsewhere");
  });
});
