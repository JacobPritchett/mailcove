import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts, type ShortcutHandlers } from "../lib/useKeyboardShortcuts";

function makeHandlers(): ShortcutHandlers {
  return {
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onOpen: vi.fn(),
    onBackToList: vi.fn(),
    onArchive: vi.fn(),
    onTrash: vi.fn(),
    onStar: vi.fn(),
    onSelect: vi.fn(),
    onSelectAll: vi.fn(),
    onSelectNone: vi.fn(),
    onReply: vi.fn(),
    onCompose: vi.fn(),
    onFocusSearch: vi.fn(),
    onUndo: vi.fn(),
    onHelp: vi.fn(),
    onEscape: vi.fn(),
    onGoView: vi.fn(),
  };
}

function key(k: string, opts: KeyboardEventInit = {}) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, ...opts }));
}

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("single-key shortcuts", () => {
    it("j → onNext", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("j");
      expect(h.onNext).toHaveBeenCalledTimes(1);
    });

    it("k → onPrev", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("k");
      expect(h.onPrev).toHaveBeenCalledTimes(1);
    });

    it("Enter → onOpen", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("Enter");
      expect(h.onOpen).toHaveBeenCalledTimes(1);
    });

    it("o → onOpen", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("o");
      expect(h.onOpen).toHaveBeenCalledTimes(1);
    });

    it("u → onBackToList", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("u");
      expect(h.onBackToList).toHaveBeenCalledTimes(1);
    });

    it("e → onArchive", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("e");
      expect(h.onArchive).toHaveBeenCalledTimes(1);
    });

    it("# → onTrash", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("#");
      expect(h.onTrash).toHaveBeenCalledTimes(1);
    });

    it("Delete → onTrash", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("Delete");
      expect(h.onTrash).toHaveBeenCalledTimes(1);
    });

    it("s → onStar", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("s");
      expect(h.onStar).toHaveBeenCalledTimes(1);
    });

    it("x → onSelect", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("x");
      expect(h.onSelect).toHaveBeenCalledTimes(1);
    });

    it("r → onReply", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("r");
      expect(h.onReply).toHaveBeenCalledTimes(1);
    });

    it("c → onCompose", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("c");
      expect(h.onCompose).toHaveBeenCalledTimes(1);
    });

    it("/ → onFocusSearch", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("/");
      expect(h.onFocusSearch).toHaveBeenCalledTimes(1);
    });

    it("z → onUndo", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("z");
      expect(h.onUndo).toHaveBeenCalledTimes(1);
    });

    it("? → onHelp", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("?");
      expect(h.onHelp).toHaveBeenCalledTimes(1);
    });

    it("Escape → onEscape", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("Escape");
      expect(h.onEscape).toHaveBeenCalledTimes(1);
    });
  });

  describe("prefix sequences — g", () => {
    it("g then i → onGoView('inbox')", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("g");
      key("i");
      expect(h.onGoView).toHaveBeenCalledWith("inbox");
    });

    it("g then s → onGoView('sent')", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("g");
      key("s");
      expect(h.onGoView).toHaveBeenCalledWith("sent");
    });

    it("g then a → onGoView('all')", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("g");
      key("a");
      expect(h.onGoView).toHaveBeenCalledWith("all");
    });

    it("g then t → onGoView('trash')", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("g");
      key("t");
      expect(h.onGoView).toHaveBeenCalledWith("trash");
    });

    it("g then r → onGoView('starred')", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("g");
      key("r");
      expect(h.onGoView).toHaveBeenCalledWith("starred");
    });

    it("bare g followed by timeout clears pending without triggering any handler", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("g");
      expect(h.onGoView).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1100);
      expect(h.onGoView).not.toHaveBeenCalled();
    });

    it("g then an unrecognised key does NOT fall through to a single-key action", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("g");
      key("e"); // not a valid g-sequence; must NOT archive
      expect(h.onArchive).not.toHaveBeenCalled();
      expect(h.onGoView).not.toHaveBeenCalled();
    });

    it("* then an unrecognised key does NOT fall through to a single-key action", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("*");
      key("#"); // not a valid *-sequence; must NOT trash
      expect(h.onTrash).not.toHaveBeenCalled();
      expect(h.onSelectAll).not.toHaveBeenCalled();
    });

    it("g does not trigger r (reply) after sequence consumed", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("g");
      key("r");
      // onReply must NOT be called — this was g+r, not bare r
      expect(h.onReply).not.toHaveBeenCalled();
      expect(h.onGoView).toHaveBeenCalledWith("starred");
    });
  });

  describe("prefix sequences — *", () => {
    it("* then a → onSelectAll", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("*");
      key("a");
      expect(h.onSelectAll).toHaveBeenCalledTimes(1);
    });

    it("* then n → onSelectNone", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("*");
      key("n");
      expect(h.onSelectNone).toHaveBeenCalledTimes(1);
    });
  });

  describe("suppression", () => {
    it("does nothing when disabled=true", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, true));
      key("j");
      key("e");
      key("c");
      expect(h.onNext).not.toHaveBeenCalled();
      expect(h.onArchive).not.toHaveBeenCalled();
      expect(h.onCompose).not.toHaveBeenCalled();
    });

    it("does nothing when an INPUT is focused", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));

      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      key("j");
      key("e");
      expect(h.onNext).not.toHaveBeenCalled();
      expect(h.onArchive).not.toHaveBeenCalled();

      document.body.removeChild(input);
    });

    it("does nothing when a TEXTAREA is focused", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));

      const ta = document.createElement("textarea");
      document.body.appendChild(ta);
      ta.focus();

      key("j");
      expect(h.onNext).not.toHaveBeenCalled();

      document.body.removeChild(ta);
    });

    it("ignores events with metaKey", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("j", { metaKey: true });
      expect(h.onNext).not.toHaveBeenCalled();
    });

    it("ignores events with ctrlKey", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("j", { ctrlKey: true });
      expect(h.onNext).not.toHaveBeenCalled();
    });

    it("ignores events with altKey", () => {
      const h = makeHandlers();
      renderHook(() => useKeyboardShortcuts(h, false));
      key("j", { altKey: true });
      expect(h.onNext).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("removes listener on unmount — keys after unmount do nothing", () => {
      const h = makeHandlers();
      const { unmount } = renderHook(() => useKeyboardShortcuts(h, false));
      unmount();
      key("j");
      expect(h.onNext).not.toHaveBeenCalled();
    });
  });
});
