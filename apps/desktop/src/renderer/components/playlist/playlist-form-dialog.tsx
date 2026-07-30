import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { getErrorMessage } from "#/lib/err";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export type PlaylistFormValues = {
  name: string;
  comment: string;
  public: boolean;
};

/** Shared by "New playlist" and "Playlist details", which differ only in labels and what they submit. */
export function PlaylistFormDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  initialValues,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  initialValues?: PlaylistFormValues;
  onSubmit: (values: PlaylistFormValues) => Promise<unknown>;
}) {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [comment, setComment] = useState(initialValues?.comment ?? "");
  const [isPublic, setIsPublic] = useState(initialValues?.public ?? false);

  // Re-seed whenever the dialog opens so it never shows the previous playlist's values.
  useEffect(() => {
    if (!open) return;
    setName(initialValues?.name ?? "");
    setComment(initialValues?.comment ?? "");
    setIsPublic(initialValues?.public ?? false);
  }, [open, initialValues?.name, initialValues?.comment, initialValues?.public]);

  const submitMutation = useMutation({
    mutationFn: () => onSubmit({ name, comment, public: isPublic }),
    onSuccess: () => onOpenChange(false),
  });

  const trimmedName = name.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

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
            <Input
              id="playlist-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Late night mix"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="playlist-comment">Description</Label>
            <Textarea
              id="playlist-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Optional"
              rows={3}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
            Visible to other users on the server
          </label>

          {submitMutation.isError ? (
            <div className="text-xs text-destructive">{getErrorMessage(submitMutation.error, "The playlist could not be saved.")}</div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmedName || submitMutation.isPending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
