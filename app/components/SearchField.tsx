import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CircleHelp, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The search grammar the Worker understands (src/searchQuery.ts), one example
 * each. `insert` is what a click puts in the box: the operator ready for its
 * value, or the whole term where there is nothing left to type. `caret` backs
 * the cursor up from the end (into the quotes of a phrase).
 */
export const SEARCH_OPERATORS: { example: string; insert: string; what: string; caret?: number }[] = [
  { example: "from:anna", insert: "from:", what: "From a sender" },
  { example: "to:me@example.com", insert: "to:", what: "Sent to an address" },
  { example: "cc:team", insert: "cc:", what: "Copied to" },
  { example: "subject:invoice", insert: "subject:", what: "Words in the subject" },
  { example: "has:attachment", insert: "has:attachment ", what: "With an attachment" },
  { example: "is:unread", insert: "is:unread ", what: "Unread (or is:read, is:starred)" },
  { example: "in:trash", insert: "in:", what: "In a folder, or in:anywhere" },
  { example: "before:2026-01-31", insert: "before:", what: "Before a date" },
  { example: "after:2026-01-01", insert: "after:", what: "On or after a date" },
  { example: "older_than:7d", insert: "older_than:", what: "Older than (d, w, m, y)" },
  { example: "newer_than:2w", insert: "newer_than:", what: "Newer than (d, w, m, y)" },
  { example: "domain:example.com", insert: "domain:", what: "To one of your domains" },
  { example: "-newsletter", insert: "-", what: "Without a word" },
  { example: '"exact phrase"', insert: '""', what: "These words, in this order", caret: 1 },
];

const HIDDEN_KEY = "search.tipsHidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, "1");
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** The input itself, for `/` and the command palette to focus. */
  inputRef?: React.Ref<HTMLInputElement>;
  /** Accessible name of the input. */
  label: string;
  autoFocus?: boolean;
  /** Extra classes for the input (its height differs between phone and desktop). */
  inputClassName?: string;
}

/**
 * The search box, with a hint that lists the search operators while the box
 * is focused and empty. The hint can be dismissed for good (the choice is
 * remembered) and brought back with the help button inside the box.
 */
export default function SearchField({
  value,
  onChange,
  onKeyDown,
  inputRef,
  label,
  autoFocus,
  inputClassName,
}: SearchFieldProps) {
  const own = useRef<HTMLInputElement | null>(null);
  const [focusWithin, setFocusWithin] = useState(false);
  const [hidden, setHidden] = useState(readHidden);
  const open = focusWithin && value === "" && !hidden;

  function setRefs(el: HTMLInputElement | null) {
    own.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) (inputRef as React.RefObject<HTMLInputElement | null>).current = el;
  }

  function insert(op: (typeof SEARCH_OPERATORS)[number]) {
    // Written to the input before the caret is placed, and placed at once:
    // doing either a frame later can land in the middle of what the user has
    // already started typing.
    flushSync(() => onChange(op.insert));
    const el = own.current;
    if (!el) return;
    el.focus();
    const at = op.insert.length - (op.caret ?? 0);
    el.setSelectionRange(at, at);
  }

  function dismiss() {
    setHidden(true);
    writeHidden(true);
    own.current?.focus();
  }

  function toggleTips() {
    const next = !hidden;
    setHidden(next);
    writeHidden(next);
    own.current?.focus();
  }

  return (
    <div
      className="relative"
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={setRefs}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search all mail…"
        aria-label={label}
        autoFocus={autoFocus}
        className={cn("pr-9 pl-8", inputClassName)}
      />
      {/* Brings the tips back after they were dismissed (and hides them again). */}
      <button
        type="button"
        onClick={toggleTips}
        // Keep focus in the input: on a phone, losing it drops the keyboard.
        onMouseDown={(e) => e.preventDefault()}
        aria-label="Search tips"
        aria-pressed={!hidden}
        title="Search tips"
        className="absolute top-1/2 right-0 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground max-md:size-11"
      >
        <CircleHelp className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="group"
          aria-label="Search operators"
          // Clicking in here must not blur the input: the blur would close
          // this panel before the click it was meant for arrives.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute top-full right-0 left-0 z-30 mt-1 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
        >
          <div className="mb-1 flex items-center justify-between gap-2 pl-1">
            <p className="text-xs font-medium text-muted-foreground">Narrow a search with</p>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Hide search tips"
              title="Hide search tips"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-11"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* Desktop: a row each, example then meaning. Phone: the examples
              as chips (the keyboard leaves little height), with the meaning
              still in each one's accessible name. */}
          <ul className="flex max-h-[45dvh] flex-wrap gap-1.5 overflow-y-auto md:max-h-[60dvh] md:flex-col md:flex-nowrap md:gap-0">
            {SEARCH_OPERATORS.map((op) => (
              <li key={op.example} className="md:w-full">
                <button
                  type="button"
                  onClick={() => insert(op)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md border px-3 text-left hover:bg-accent md:min-h-0 md:border-0 md:px-1.5 md:py-1"
                >
                  <code className="shrink-0 font-mono text-xs text-foreground">{op.example}</code>{" "}
                  <span className="min-w-0 truncate text-xs text-muted-foreground max-md:sr-only">{op.what}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
