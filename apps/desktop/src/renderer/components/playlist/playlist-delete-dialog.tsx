import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { getErrorMessage } from "#/lib/err";
import { useMutation } from "@tanstack/react-query";

export function PlaylistDeleteDialog({
  open,
  onOpenChange,
  playlistName,
  onConfirm,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playlistName: string;
  onConfirm: () => Promise<unknown>;
  onDeleted: () => void;
}) {
  const deleteMutation = useMutation({
    mutationFn: onConfirm,
    onSuccess: () => {
      onOpenChange(false);
      onDeleted();
    },
  });

  const setOpen = (nextOpen: boolean) => {
    if (deleteMutation.isPending) return;
    if (!nextOpen) deleteMutation.reset();
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={!deleteMutation.isPending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete playlist?</DialogTitle>
          <DialogDescription>“{playlistName}” will be removed from this device and from the server. This action cannot be undone.</DialogDescription>
        </DialogHeader>

        {deleteMutation.isError ? <p className="text-xs text-destructive">{getErrorMessage(deleteMutation.error, "The playlist could not be deleted.")}</p> : null}

        <DialogFooter>
          <Button type="button" variant="secondary" disabled={deleteMutation.isPending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
            {deleteMutation.isPending ? "Deleting..." : "Delete playlist"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
