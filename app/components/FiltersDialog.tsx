import { useId, useState } from "react";
import { Ban, Filter as FilterIcon, Plus, Trash2, Archive, Star, MailOpen, Trash } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { useFilters, useFilterMutations, useBlocked, useBlockedMutations } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { asSentence } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  FILTER_FIELDS,
  FILTER_OPS,
  FILTER_ACTIONS,
  type Filter,
  type FilterAction,
  type NewFilter,
} from "@/lib/types";

export interface FiltersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ACTION_LABEL: Record<FilterAction, string> = {
  archive: "Archive",
  trash: "Trash",
  star: "Star",
  read: "Mark read",
};
const ACTION_ICON: Record<FilterAction, typeof Archive> = {
  archive: Archive,
  trash: Trash,
  star: Star,
  read: MailOpen,
};
const OP_LABEL: Record<string, string> = { contains: "contains", equals: "is" };

/** One rule row: readable sentence + enable toggle + delete. */
function RuleRow({ filter }: { filter: Filter }) {
  const { toggle, remove } = useFilterMutations();
  const Icon = ACTION_ICON[filter.action];
  return (
    <li className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
      <Checkbox
        checked={filter.enabled === 1}
        aria-label={filter.enabled ? "Disable rule" : "Enable rule"}
        onCheckedChange={(c) => toggle.mutate({ id: filter.id, enabled: c === true })}
      />
      <span className={cn("min-w-0 flex-1 truncate", filter.enabled ? "" : "text-muted-foreground line-through")}>
        If <span className="font-medium">{filter.field}</span> {OP_LABEL[filter.op] ?? filter.op}{" "}
        <span className="font-medium">“{filter.value}”</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
        <Icon className="h-3 w-3" />
        {ACTION_LABEL[filter.action]}
      </span>
      <button
        type="button"
        onClick={() => remove.mutate(filter.id, { onSuccess: () => toast("Rule deleted") })}
        aria-label="Delete rule"
        className="flex size-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive max-md:size-11"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

/** The add-rule form. */
function AddRule() {
  const { create } = useFilterMutations();
  const [draft, setDraft] = useState<NewFilter>({ field: "from", op: "contains", value: "", action: "archive" });
  const selectCls = "h-9 min-w-0 rounded border bg-background px-2 text-sm";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = draft.value.trim();
    if (!value) return;
    create.mutate(
      { ...draft, value },
      {
        onSuccess: () => {
          toast.success("Rule added");
          setDraft((d) => ({ ...d, value: "" }));
        },
        onError: () => toast.error("Couldn't add rule"),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3">
      <span className="text-sm text-muted-foreground">If</span>
      <select
        value={draft.field}
        onChange={(e) => setDraft((d) => ({ ...d, field: e.target.value as NewFilter["field"] }))}
        aria-label="Field"
        className={selectCls}
      >
        {FILTER_FIELDS.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
      <select
        value={draft.op}
        onChange={(e) => setDraft((d) => ({ ...d, op: e.target.value as NewFilter["op"] }))}
        aria-label="Operator"
        className={selectCls}
      >
        {FILTER_OPS.map((o) => (
          <option key={o} value={o}>{OP_LABEL[o]}</option>
        ))}
      </select>
      <Input
        value={draft.value}
        onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
        placeholder="value…"
        aria-label="Match value"
        className="h-9 min-w-0 flex-1"
      />
      <span className="text-sm text-muted-foreground">→</span>
      <select
        value={draft.action}
        onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value as NewFilter["action"] }))}
        aria-label="Action"
        className={selectCls}
      >
        {FILTER_ACTIONS.map((a) => (
          <option key={a} value={a}>{ACTION_LABEL[a]}</option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={create.isPending || !draft.value.trim()} className="h-9 gap-1.5">
        <Plus className="h-4 w-4" /> Add
      </Button>
    </form>
  );
}

/**
 * Blocked senders: mail from these goes straight to Junk. An entry is an
 * address, or a whole domain written "@example.com". The Worker is the judge
 * of what is valid (and refuses our own domains), so its message is shown
 * under the field rather than second-guessed here.
 */
function BlockedSenders({ enabled }: { enabled: boolean }) {
  const { data, isPending, isError } = useBlocked(enabled);
  const { add, remove } = useBlockedMutations();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const headingId = useId();
  const blocked = data?.blocked ?? [];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const address = value.trim();
    if (!address) return;
    setError(null);
    add.mutate(address, {
      onSuccess: () => setValue(""),
      onError: (err) =>
        setError(
          err instanceof ApiError && err.status === 400 && err.message
            ? asSentence(err.message)
            : "Couldn't block that sender. Try again.",
        ),
    });
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
          <Ban className="h-4 w-4" /> Blocked senders
        </h3>
        <p className="text-sm text-muted-foreground">
          New mail from these senders goes straight to Junk.
        </p>
      </div>
      <form onSubmit={submit} className="rounded-md border border-dashed p-3">
        <div className="flex items-center gap-2">
          <Input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="name@example.com or @example.com"
            aria-label="Address or domain to block"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-9 min-w-0 flex-1 max-md:h-11"
          />
          <Button
            type="submit"
            size="sm"
            disabled={add.isPending || !value.trim()}
            className="h-9 gap-1.5 max-md:h-11"
          >
            <Plus className="h-4 w-4" /> Block
          </Button>
        </div>
        {error && (
          <p id={errorId} role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
      {isPending && <p className="text-sm text-muted-foreground">Loading blocked senders…</p>}
      {isError && <p className="text-sm text-muted-foreground">Couldn't load blocked senders.</p>}
      {!isPending && !isError && blocked.length === 0 && (
        <p className="text-sm text-muted-foreground">Nobody is blocked.</p>
      )}
      {blocked.length > 0 && (
        <ul className="space-y-2">
          {blocked.map((b) => (
            <li key={b.address} className="flex items-center gap-3 rounded-md border py-1 pr-1 pl-3 text-sm">
              <span className="min-w-0 flex-1 truncate" title={b.address}>
                {b.address.startsWith("@") ? `Everyone at ${b.address.slice(1)}` : b.address}
              </span>
              <button
                type="button"
                onClick={() =>
                  remove.mutate(b.address, {
                    onSuccess: () => toast(`Unblocked ${b.address}`),
                    onError: () => toast.error(`Couldn't unblock ${b.address}`),
                  })
                }
                aria-label={`Unblock ${b.address}`}
                className="flex size-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive max-md:size-11"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Inbox rules manager: create simple "if a field matches, do an action" rules
 * that apply to new mail as it arrives.
 */
export default function FiltersDialog({ open, onOpenChange }: FiltersDialogProps) {
  const { data, isPending, isError } = useFilters(open);
  const filters = data?.filters ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 max-md:h-[100dvh] max-md:max-h-[100dvh] max-md:max-w-full max-md:rounded-none sm:max-w-2xl lg:max-w-3xl">
        <DialogHeader className="space-y-1 border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <FilterIcon className="h-5 w-5" /> Rules
          </DialogTitle>
          <DialogDescription>
            Automatically archive, trash, star, or mark new mail read when it matches.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <AddRule />
          {isPending && <p className="text-sm text-muted-foreground">Loading rules…</p>}
          {isError && <p className="text-sm text-muted-foreground">Couldn't load rules.</p>}
          {!isPending && !isError && filters.length === 0 && (
            <p className="text-sm text-muted-foreground">No rules yet. Add one above.</p>
          )}
          {filters.length > 0 && (
            <ul className="space-y-2">
              {filters.map((f) => (
                <RuleRow key={f.id} filter={f} />
              ))}
            </ul>
          )}
          <Separator />
          <BlockedSenders enabled={open} />
        </div>

        <Separator />
        <p className="px-5 py-2 text-xs text-muted-foreground">
          Rules apply to mail received after they're added. Matching is case-insensitive.
        </p>
      </DialogContent>
    </Dialog>
  );
}
