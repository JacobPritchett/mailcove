import { useEffect, useRef } from "react";
import type { View } from "./types";

export interface ShortcutHandlers {
  onNext(): void;
  onPrev(): void;
  onOpen(): void;
  onBackToList(): void;
  onArchive(): void;
  onTrash(): void;
  onStar(): void;
  onSpam(): void;
  onSnooze(): void;
  onSelect(): void;
  onSelectAll(): void;
  onSelectNone(): void;
  onReply(): void;
  onReplyAll(): void;
  onForward(): void;
  onCompose(): void;
  onFocusSearch(): void;
  onUndo(): void;
  onHelp(): void;
  onEscape(): void;
  onGoView(view: View): void;
}

function inEditable(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable)
  );
}

// A menu counts too: with one open, a letter is typeahead for its items, not
// a mail command (pressing `e` to reach an item must not archive the thread).
const DIALOG = '[role="dialog"],[role="alertdialog"],[role="menu"]';

/**
 * Is this key being typed into a dialog? Checked on both the event target and
 * the focused element: Radix traps focus inside an open dialog, so either is
 * enough, and together they cover a confirm, a sheet and a full dialog without
 * App having to list every one of them in `disabled`.
 */
function inDialog(e: KeyboardEvent): boolean {
  const target = e.target;
  if (target instanceof Element && target.closest(DIALOG)) return true;
  return !!document.activeElement?.closest(DIALOG);
}

type Prefix = "g" | "*" | null;

/**
 * Central keyboard shortcut handler. Registers a single `keydown` listener on
 * `document`. Suppressed while `disabled` is true, while focus is inside an
 * editable element or any dialog, for keys another handler already consumed,
 * and during IME composition. Supports single-key shortcuts and two-key prefix sequences (`g` and
 * `*`). The prefix timeout is 1000ms.
 */
export function useKeyboardShortcuts(
  handlers: ShortcutHandlers,
  disabled: boolean,
): void {
  // Keep handlers in a ref so the listener always sees the latest without
  // needing to re-subscribe when handler references change.
  const handlersRef = useRef<ShortcutHandlers>(handlers);
  handlersRef.current = handlers;

  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const pendingPrefixRef = useRef<Prefix>(null);
  const prefixTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function clearPrefix() {
      if (prefixTimerRef.current !== null) {
        clearTimeout(prefixTimerRef.current);
        prefixTimerRef.current = null;
      }
      pendingPrefixRef.current = null;
    }

    function setPending(prefix: Prefix) {
      if (prefixTimerRef.current !== null) {
        clearTimeout(prefixTimerRef.current);
      }
      pendingPrefixRef.current = prefix;
      prefixTimerRef.current = setTimeout(clearPrefix, 1000);
    }

    function onKeyDown(e: KeyboardEvent) {
      // Always ignore modifier-key combos
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (disabledRef.current) return;
      // Someone else already handled this key (e.g. a dialog closing on
      // Escape). Acting on it too is how Escape on "Delete forever?" also
      // cleared the selection.
      if (e.defaultPrevented) return;
      // Composing text with an IME: these keys are input, not commands.
      // (keyCode 229 is how Safari reports it.)
      if (e.isComposing || e.keyCode === 229) return;
      if (inEditable()) return;
      if (inDialog(e)) return;

      const h = handlersRef.current;
      const pending = pendingPrefixRef.current;
      const k = e.key;

      // --- Prefix sequences ---
      if (pending === "g") {
        clearPrefix();
        switch (k) {
          case "i": h.onGoView("inbox"); return;
          case "s": h.onGoView("sent"); return;
          case "a": h.onGoView("all"); return;
          case "t": h.onGoView("trash"); return;
          case "r": h.onGoView("starred"); return;
        }
        // Prefix consumed: an unrecognised key after `g` must NOT fall through
        // to single-key actions (so `g` then `e` does nothing, never archives).
        return;
      } else if (pending === "*") {
        clearPrefix();
        switch (k) {
          case "a": h.onSelectAll(); return;
          case "n": h.onSelectNone(); return;
        }
        // Prefix consumed: don't fall through to single-key actions.
        return;
      }

      // --- Single-key shortcuts ---
      switch (k) {
        case "g":
          setPending("g");
          return;
        case "*":
          setPending("*");
          return;
        case "j":
          h.onNext();
          break;
        case "k":
          h.onPrev();
          break;
        case "Enter":
        case "o":
          h.onOpen();
          break;
        case "u":
          h.onBackToList();
          break;
        case "e":
          h.onArchive();
          break;
        case "#":
        case "Delete":
          h.onTrash();
          break;
        case "s":
          h.onStar();
          break;
        case "!":
          h.onSpam();
          break;
        // Opens a menu that takes focus: consume the key, as for reply.
        case "b":
          e.preventDefault();
          h.onSnooze();
          break;
        case "x":
          h.onSelect();
          break;
        // These three move focus into a text field. Consume the key, or the
        // field (focused before the browser inserts the character) receives it.
        case "r":
          e.preventDefault();
          h.onReply();
          break;
        case "a":
          e.preventDefault();
          h.onReplyAll();
          break;
        case "f":
          e.preventDefault();
          h.onForward();
          break;
        case "c":
          e.preventDefault();
          h.onCompose();
          break;
        case "/":
          e.preventDefault();
          h.onFocusSearch();
          break;
        case "z":
          h.onUndo();
          break;
        case "?":
          h.onHelp();
          break;
        case "Escape":
          h.onEscape();
          break;
        default:
          break;
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (prefixTimerRef.current !== null) {
        clearTimeout(prefixTimerRef.current);
      }
    };
  }, []); // stable — never re-subscribe; refs keep current values
}
