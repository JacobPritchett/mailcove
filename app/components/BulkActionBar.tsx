import { Archive, RotateCcw, Star, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { MailAction, View } from "@/lib/types";

export interface BulkActionBarProps {
  count: number;
  view: View;
  onAction: (action: MailAction) => void;
  onClear: () => void;
}

export default function BulkActionBar({
  count,
  view,
  onAction,
  onClear,
}: BulkActionBarProps) {
  const isTrash = view === "trash";

  return (
    <div className="flex items-center gap-1 border-b bg-accent/30 px-3 py-1.5">
      <span className="mr-1 text-sm font-medium text-foreground">
        {count} selected
      </span>

      {isTrash ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAction("restore")}
            aria-label="Restore selected"
          >
            <RotateCcw className="h-4 w-4" />
            Restore
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Delete selected forever"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Delete forever
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {count} message{count !== 1 ? "s" : ""} forever?</AlertDialogTitle>
                <AlertDialogDescription>
                  {count === 1
                    ? "This message will be permanently deleted and cannot be recovered."
                    : `These ${count} messages will be permanently deleted and cannot be recovered.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  onClick={() => onAction("delete")}
                >
                  Delete forever
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAction("archive")}
            aria-label="Archive selected"
          >
            <Archive className="h-4 w-4" />
            Archive
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAction("trash")}
            aria-label="Move selected to trash"
          >
            <Trash2 className="h-4 w-4" />
            Trash
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAction("star")}
            aria-label="Star selected"
          >
            <Star className="h-4 w-4" />
            Star
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAction("read")}
            aria-label="Mark selected as read"
          >
            Mark read
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAction("unread")}
            aria-label="Mark selected as unread"
          >
            Mark unread
          </Button>
        </>
      )}

      <div className="ml-auto">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
