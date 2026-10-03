import { useState } from "react";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  MailCheck,
  MailOpen,
  MoreHorizontal,
  OctagonAlert,
  RotateCcw,
  ShieldCheck,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
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
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SnoozeMenu from "@/components/SnoozeMenu";
import { cn } from "@/lib/utils";
import type { ActionOptions } from "@/lib/useThreadActions";
import type { MailAction, View } from "@/lib/types";

export interface BulkActionBarProps {
  count: number;
  view: View;
  onAction: (action: MailAction, opts?: ActionOptions) => void;
  onClear: () => void;
  className?: string;
}

/**
 * An icon button of the bar. Icons only, on every screen: the list column is
 * 320px on desktop and a phone is not much wider, and five labelled buttons
 * fit neither (they ran over the reader on one and were cut off on the
 * other). The name is the accessible label and the tooltip. 44px on a phone.
 */
function BarButton({
  icon: Icon,
  name,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & { icon: LucideIcon; name: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={name}
      title={name}
      className={cn("max-md:size-11", className)}
      {...props}
    >
      <Icon className="size-4 max-md:size-5" />
    </Button>
  );
}

/**
 * Actions for the selected threads. Leads with the way out (Clear selection)
 * and the count, then the actions that fit; the rest are under More.
 */
export default function BulkActionBar({ count, view, onAction, onClear, className }: BulkActionBarProps) {
  const isTrash = view === "trash";
  const isJunk = view === "spam";
  const isSnoozed = view === "snoozed";
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div
      role="toolbar"
      aria-label="Actions for the selected conversations"
      className={cn("flex items-center gap-0.5 border-b bg-accent/30 px-2 py-1 md:px-3", className)}
    >
      <BarButton icon={X} name="Clear selection" onClick={onClear} />
      <span className="mr-auto min-w-0 truncate pl-1 text-sm font-medium text-foreground" aria-live="polite">
        {count} selected
      </span>

      {isTrash || isJunk ? (
        <>
          {isJunk ? (
            <BarButton icon={ShieldCheck} name="Mark selected as not junk" onClick={() => onAction("unspam")} />
          ) : (
            <BarButton icon={RotateCcw} name="Restore selected" onClick={() => onAction("restore")} />
          )}
          <BarButton
            icon={Trash2}
            name="Delete selected forever"
            onClick={() => setConfirmDelete(true)}
            className="text-destructive hover:text-destructive"
          />
          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
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
          <BarButton icon={Archive} name="Archive selected" onClick={() => onAction("archive")} />
          <BarButton icon={Trash2} name="Move selected to trash" onClick={() => onAction("trash")} />
          <BarButton icon={MailCheck} name="Mark selected as read" onClick={() => onAction("read")} />
          {/* Not where it can never apply (Sent, Snoozed). Elsewhere a thread
              that is not in the inbox is refused by the Worker, with a reason. */}
          {(view === "inbox" || view === "starred" || view === "all") && (
            <SnoozeMenu onSnooze={(until) => onAction("snooze", { until })}>
              <BarButton icon={AlarmClock} name="Snooze selected" />
            </SnoozeMenu>
          )}
          {isSnoozed && (
            <BarButton icon={AlarmClockOff} name="Unsnooze selected" onClick={() => onAction("unsnooze")} />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <BarButton icon={MoreHorizontal} name="More actions for the selection" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onAction("unread")}>
                <MailOpen /> Mark as unread
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAction("star")}>
                <Star /> Star
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAction("spam")}>
                <OctagonAlert /> Report junk
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
