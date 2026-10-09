import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { getErrorMessage } from "#/lib/err";
import type { PlaylistDetails } from "@muswag/model";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

type PlaylistFormProps = {
  submitLabel: string;
  initialValues?: PlaylistDetails | undefined;
  onSubmit: (values: PlaylistDetails) => Promise<unknown>;
  /** Called when the form is done with: cancelled, or submitted successfully. */
  onClose: () => void;
};

/** Shared by "New playlist" and "Playlist details", which differ only in labels and what they submit. */
export function PlaylistFormDialog({
  open,
  onOpenChange,
  title,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
} & Omit<PlaylistFormProps, "onClose">) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <PlaylistForm {...form} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The fields of the dialog. It is mounted when the dialog opens, so the fields start from
 * `initialValues` as they are then and belong to the user afterwards: a save that changed the
 * playlist's name before failing on its description leaves what was typed in place.
 */
function PlaylistForm({ submitLabel, initialValues, onSubmit, onClose }: PlaylistFormProps) {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [comment, setComment] = useState(initialValues?.comment ?? "");
  const [isPublic, setIsPublic] = useState(initialValues?.public ?? false);

  const submitMutation = useMutation({
    mutationFn: () => onSubmit({ name, comment, public: isPublic }),
    onSuccess: onClose,
  });

  const trimmedName = name.trim();

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmedName) return;
        submitMutation.mutate();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="playlist-name">Name</Label>
        <Input id="playlist-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Late night mix" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="playlist-comment">Description</Label>
        <Textarea id="playlist-comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Optional" rows={3} />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={isPublic} onCheckedChange={setIsPublic} />
        Visible to other users on the server
      </label>

      {submitMutation.isError ? <div className="text-xs text-destructive">{getErrorMessage(submitMutation.error, "The playlist could not be saved.")}</div> : null}

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!trimmedName || submitMutation.isPending}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
