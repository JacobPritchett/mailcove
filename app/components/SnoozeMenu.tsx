import { useId, useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  parseSnoozeInput,
  snoozeInputBounds,
  snoozePresets,
  toDateTimeInputValue,
  type SnoozePreset,
} from "@/lib/snooze";

export interface SnoozeMenuProps {
  /** The button that opens the menu (rendered as the menu's trigger). */
  children: React.ReactNode;
  /** Called with the chosen time, epoch ms. */
  onSnooze: (until: number) => void;
  /** Controlled open state, for the keyboard shortcut. Uncontrolled when absent. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
}

/**
 * The snooze control: a small menu of presets, each showing the day and time
 * it resolves to, plus a date field for anything else. The times come from
 * lib/snooze and are worked out when the menu opens, so a menu opened at 8:59
 * and one opened at 9:01 each offer what is true at that moment.
 */
export default function SnoozeMenu({ children, onSnooze, open, onOpenChange, align = "end" }: SnoozeMenuProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const [presets, setPresets] = useState<SnoozePreset[]>([]);
  const [picking, setPicking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Close the date dialog and hand focus back to the button that began it.
   *  The dialog would return it to the menu item that opened it, which is
   *  gone, leaving focus on the page body. */
  function closePicker() {
    setPicking(false);
    window.setTimeout(() => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus();
    }, 0);
  }

  function handleOpenChange(next: boolean) {
    setOwnOpen(next);
    onOpenChange?.(next);
  }
  // Recomputed on every opening, however it was opened (a click here, or the
  // shortcut flipping `open` from outside).
  const [seenOpen, setSeenOpen] = useState(false);
  if (isOpen !== seenOpen) {
    setSeenOpen(isOpen);
    if (isOpen) setPresets(snoozePresets(new Date()));
  }

  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild ref={triggerRef}>
          {children}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="min-w-[15rem]">
          <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
          {presets.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => onSnooze(p.at)} className="justify-between gap-6">
              <span>{p.label}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{p.when}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPicking(true)}>
            <CalendarClock /> Pick a date and time
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {picking && <SnoozePicker onClose={closePicker} onSnooze={onSnooze} />}
    </>
  );
}

/** The custom time: a native date and time field, future only. */
function SnoozePicker({ onClose, onSnooze }: { onClose: () => void; onSnooze: (until: number) => void }) {
  // Fixed for the life of the dialog so the bounds do not shift under the user;
  // the submit check below uses the clock at that moment.
  const [openedAt] = useState(() => Date.now());
  const bounds = snoozeInputBounds(openedAt);
  // Start on something sensible: tomorrow morning.
  const [value, setValue] = useState(() => {
    const tomorrow = snoozePresets(new Date(openedAt)).find((p) => p.id === "tomorrow");
    return tomorrow ? toDateTimeInputValue(tomorrow.at) : bounds.min;
  });
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseSnoozeInput(value, Date.now());
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    onClose();
    onSnooze(parsed.at);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Snooze until</DialogTitle>
            <DialogDescription>
              The conversation leaves your inbox and comes back, unread, at this time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor={fieldId} className="text-sm font-medium">
              Date and time
            </label>
            <Input
              id={fieldId}
              type="datetime-local"
              value={value}
              min={bounds.min}
              max={bounds.max}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className="h-11 md:h-9"
            />
            {error && (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} className="max-md:h-11">
              Cancel
            </Button>
            <Button type="submit" className="max-md:h-11">
              Snooze
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
