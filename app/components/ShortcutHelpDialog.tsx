import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface ShortcutHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A small helper to render a keyboard key chip. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="pointer-events-none inline-flex h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[0.65rem] font-medium">
      {children}
    </kbd>
  );
}

/** A shortcut row: key(s) on the left, description on the right. */
function Row({ keys, label }: { keys: React.ReactNode[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
}

/** Thin separator with a group heading. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </p>
      {children}
    </div>
  );
}

/**
 * `?` help dialog listing all keyboard shortcuts. Controlled by the parent
 * (open / onOpenChange) — the `?` key wires to `setHelpOpen(true)` in App.
 */
export default function ShortcutHelpDialog({
  open,
  onOpenChange,
}: ShortcutHelpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts are suppressed while typing in a field or a dialog is
            open.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-4">
          <Group title="Navigation">
            <Row keys={["j"]} label="Next thread" />
            <Row keys={["k"]} label="Previous thread" />
            <Row keys={["Enter"]} label="Open selected thread" />
            <Row keys={["o"]} label="Open selected thread" />
            <Row keys={["u"]} label="Back to list" />
          </Group>

          <Group title="Actions">
            <Row keys={["e"]} label="Archive" />
            <Row keys={["#"]} label="Move to trash" />
            <Row keys={["s"]} label="Toggle star" />
            <Row keys={["r"]} label="Reply" />
            <Row keys={["c"]} label="Compose" />
            <Row keys={["z"]} label="Undo last action" />
          </Group>

          <Group title="Selection">
            <Row keys={["x"]} label="Toggle select current thread" />
            <Row keys={["*", "a"]} label="Select all" />
            <Row keys={["*", "n"]} label="Select none" />
          </Group>

          <Group title="Go to">
            <Row keys={["g", "i"]} label="Inbox" />
            <Row keys={["g", "s"]} label="Sent" />
            <Row keys={["g", "a"]} label="All mail" />
            <Row keys={["g", "t"]} label="Trash" />
            <Row keys={["g", "r"]} label="Starred" />
          </Group>

          <Group title="Help">
            <Row keys={["?"]} label="Show this dialog" />
            <Row keys={["Esc"]} label="Clear selection / back to list" />
          </Group>
        </div>
      </DialogContent>
    </Dialog>
  );
}
