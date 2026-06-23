import { useEffect } from "react";
import { Inbox, Keyboard, PenSquare, Search, Send, Star, Mails, Trash2, Globe, Filter } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import type { View } from "@/lib/types";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the (empty) compose dialog. */
  onCompose: () => void;
  /** Navigate to a specific view. */
  onGoView: (view: View) => void;
  /** Focus the message-list search input. */
  onFocusSearch: () => void;
  /** Show the keyboard shortcuts help dialog. */
  onShowShortcuts?: () => void;
  /** Open the read-only Domains admin dashboard. */
  onOpenDomains?: () => void;
  /** Open the inbox rules manager. */
  onOpenFilters?: () => void;
}

/**
 * ⌘K / Ctrl+K command palette. Registers a global keydown listener that toggles
 * the palette; each action closes the palette and invokes its callback.
 */
export default function CommandPalette({
  open,
  onOpenChange,
  onCompose,
  onGoView,
  onFocusSearch,
  onShowShortcuts,
  onOpenDomains,
  onOpenFilters,
}: CommandPaletteProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  /** Run an action and close the palette. */
  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(onCompose)}>
            <PenSquare />
            <span>Compose new message</span>
            <CommandShortcut>C</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(onFocusSearch)}>
            <Search />
            <span>Focus search</span>
            <CommandShortcut>/</CommandShortcut>
          </CommandItem>
          {onOpenFilters && (
            <CommandItem onSelect={() => run(onOpenFilters)}>
              <Filter />
              <span>Rules (inbox filters)</span>
            </CommandItem>
          )}
          {onOpenDomains && (
            <CommandItem onSelect={() => run(onOpenDomains)}>
              <Globe />
              <span>Domains (Email Routing)</span>
            </CommandItem>
          )}
          {onShowShortcuts && (
            <CommandItem onSelect={() => run(onShowShortcuts)}>
              <Keyboard />
              <span>Keyboard shortcuts</span>
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
          )}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Go to">
          <CommandItem onSelect={() => run(() => onGoView("inbox"))}>
            <Inbox />
            <span>Go to Inbox</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onGoView("starred"))}>
            <Star />
            <span>Go to Starred</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onGoView("sent"))}>
            <Send />
            <span>Go to Sent</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onGoView("all"))}>
            <Mails />
            <span>Go to All Mail</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onGoView("trash"))}>
            <Trash2 />
            <span>Go to Trash</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
