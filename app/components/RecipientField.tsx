// A recipient row: address chips, live parsing of typed or pasted lists, and
// suggestions from mail already exchanged. Used for Cc and Bcc; the To row in
// ComposeDialog predates this and carries the same behaviour inline.
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import AnchoredListbox from "@/components/AnchoredListbox";
import { getContacts } from "@/lib/api";
import { keyIsSpokenFor } from "@/lib/keys";
import { commitRecipients, type CommitResult } from "@/lib/recipients";
import type { Contact } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface RecipientFieldHandle {
  /** Fold any typed fragment into chips (fully validated) and report the result. */
  flush(): CommitResult;
  focus(): void;
  /** Text typed but not yet committed, for draft autosave. */
  pending(): string;
}

interface RecipientFieldProps {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** Addresses already used elsewhere on the message, left out of suggestions. */
  exclude?: string[];
  /** Notified when the uncommitted text changes, so a draft can include it. */
  onPendingChange?: (text: string) => void;
}

const FIELD =
  "w-full bg-transparent text-base md:text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none";

export const RecipientField = forwardRef<RecipientFieldHandle, RecipientFieldProps>(function RecipientField(
  { label, value, onChange, exclude = [], onPendingChange },
  ref,
) {
  const uid = useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const errorId = `${uid}-error`;
  const [input, setInputState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<Contact[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  function setInput(next: string) {
    setInputState(next);
    onPendingChange?.(next);
  }

  function flush(raw: string, keepTrailing: boolean): CommitResult {
    const r = commitRecipients(value, raw, { keepTrailing });
    if (r.recipients.length !== value.length) onChange(r.recipients);
    setInput(keepTrailing ? r.remainder : "");
    setError(r.invalid.length ? `Not a valid email: ${r.invalid.join(", ")}` : null);
    return r;
  }

  useImperativeHandle(ref, () => ({
    flush: () => flush(input, false),
    focus: () => inputRef.current?.focus(),
    pending: () => input.trim(),
  }));

  const skip = [...value, ...exclude].join("\n").toLowerCase();
  useEffect(() => {
    const q = input.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const mine = ++seq.current;
    const taken = new Set(skip.split("\n"));
    const t = setTimeout(() => {
      getContacts(q)
        .then((r) => {
          // Ignore a response that a newer keystroke has already superseded.
          if (mine !== seq.current) return;
          setHits(r.contacts.filter((c) => !taken.has(c.email.toLowerCase())));
          setIndex(0);
        })
        .catch(() => {
          if (mine === seq.current) setHits([]);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [input, skip]);

  function accept(c: Contact) {
    const r = commitRecipients(value, c.email, { keepTrailing: false });
    onChange(r.recipients);
    setInput("");
    setError(null);
    setHits([]);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // An IME committing its composition, or a key something else handled.
    if (keyIsSpokenFor(e)) return;
    // Let the form-level Cmd/Ctrl+Enter handler send instead of adding a chip.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") return;
    if (hits.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (i + 1) % hits.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i - 1 + hits.length) % hits.length);
        return;
      }
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        accept(hits[index]);
        return;
      }
      if (e.key === "Escape") {
        // Close the list only; the dialog's own Escape handling checks this.
        e.stopPropagation();
        setHits([]);
        return;
      }
    }
    if (e.key === "Enter" || e.key === ";" || e.key === ",") {
      // Plain Enter never submits the form from a recipient field.
      e.preventDefault();
      flush(input, false);
    } else if (e.key === "Backspace" && input === "" && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex items-start gap-3 border-b border-border/60 px-5 py-3">
      <label
        htmlFor={inputId}
        className="w-12 shrink-0 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </label>
      <div
        ref={fieldRef}
        // min-w-0 and a truncating chip: a long address stays inside the row.
        className="flex min-w-0 flex-1 cursor-text flex-wrap items-center gap-1.5"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((addr) => (
          <span
            key={addr}
            title={addr}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs font-medium text-foreground"
          >
            <span className="min-w-0 truncate">{addr}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((a) => a !== addr));
                inputRef.current?.focus();
              }}
              aria-label={`Remove ${addr}`}
              // Looks 16px; on a touch screen an invisible ::after takes taps
                    // over a 44px square around it.
                    className="relative flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3.5 [@media(pointer:coarse)]:after:content-['']"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          value={input}
          onChange={(e) => flush(e.target.value, true)}
          onKeyDown={onKeyDown}
          onBlur={() => flush(input, false)}
          type="text"
          inputMode="email"
          autoComplete="off"
          aria-label={`Add ${label} recipient`}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={hits.length ? `${listId}-${index}` : undefined}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className={cn(FIELD, "min-w-[8rem] flex-1 py-1")}
        />
        {hits.length > 0 && (
          <AnchoredListbox
            anchorRef={fieldRef}
            id={listId}
            role="listbox"
            aria-label={`${label} suggestions`}
            className="z-50 overflow-y-auto rounded-lg border border-border/60 bg-popover py-1 shadow-md"
          >
            {hits.map((c, i) => (
              <li
                key={c.email}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === index}
                // Commit on mouseDown: blur would otherwise flush the typed
                // fragment into a chip before the click lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(c);
                }}
                onMouseEnter={() => setIndex(i)}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                  i === index ? "bg-accent" : "bg-transparent",
                )}
              >
                {c.name && <span className="truncate font-medium">{c.name}</span>}
                <span className="truncate text-muted-foreground">{c.email}</span>
              </li>
            ))}
          </AnchoredListbox>
        )}
        {error && (
          <p id={errorId} role="alert" className="flex w-full items-center gap-1.5 pt-1 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
});
