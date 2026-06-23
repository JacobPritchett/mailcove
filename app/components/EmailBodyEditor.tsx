// Rich compose body: @react-email/editor (TipTap-based) with markdown input
// rules, "/" slash commands, and selection bubble menus. This module is
// LAZY-loaded (React.lazy in ComposeDialog) so the editor bundle stays out of
// the initial chunk; in jsdom tests it's aliased to a textarea-backed mock
// (vitest.config.ts) implementing the same ComposeBodyHandle contract.
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { EmailEditor, type EmailEditorProps, type EmailEditorRef } from "@react-email/editor";
import "@react-email/editor/themes/default.css";
import { plainTextToHtml } from "@/lib/plainText";
import { parseEditorDoc } from "@/lib/editorDoc";
import { cn } from "@/lib/utils";

/** Imperative contract ComposeDialog drives the body through. */
export interface ComposeBodyHandle {
  /** Email-ready HTML + plaintext of the current document. */
  getEmail(): Promise<{ html: string; text: string }>;
  /** Current document as stringified TipTap JSON (draft autosave). */
  getDocJson(): string;
  /** Replace the whole document with plain text (paragraphs/quotes preserved). */
  setPlainText(text: string): void;
  /** Append plain text at the very end of the document (Smart Compose accept). */
  appendPlainText(text: string): void;
  focus(): void;
}

export interface EmailBodyEditorProps {
  /** Plain-text seed (reply prefills carry "> "-quoted lines). */
  initialText?: string;
  /** Stringified TipTap document — faithful draft resume. Wins over initialText. */
  initialJson?: string;
  placeholder?: string;
  /** Live plain-text mirror of the document (Smart Compose, AI-draft quoting). */
  onTextChange?: (text: string) => void;
  onFocusChange?: (focused: boolean) => void;
  /** Whether the caret sits at the very end of the document. */
  onCaretAtEndChange?: (atEnd: boolean) => void;
  /** Focus the document at this position once the editor is ready. */
  autoFocus?: "start" | "end";
  className?: string;
}

type TiptapEditor = NonNullable<EmailEditorRef["editor"]>;

// The built-in editor themes hardcode a white body/container and #000 text
// into the SENT html, which renders as a stark white slab in recipients'
// dark-mode clients. Personal mail should carry no page colors at all (like
// Gmail's composer) so the recipient's client themes it — empty-string
// overrides clear the defaults: React drops empty style values, so the
// properties vanish from the serialized email instead of being repainted.
const NEUTRAL_EMAIL_THEME: EmailEditorProps["theme"] = {
  extends: "basic",
  styles: {
    body: { backgroundColor: "" },
    container: { backgroundColor: "", color: "", borderColor: "" },
  },
};

function caretAtEnd(editor: TiptapEditor): boolean {
  const sel = editor.state.selection;
  // The last valid text position is doc.content.size - 1 (inside the final
  // textblock); an empty doc trivially satisfies this.
  return sel.empty && sel.to >= editor.state.doc.content.size - 1;
}

const EmailBodyEditor = forwardRef<ComposeBodyHandle, EmailBodyEditorProps>(
  function EmailBodyEditor(
    { initialText, initialJson, placeholder, onTextChange, onFocusChange, onCaretAtEndChange, autoFocus, className },
    ref,
  ) {
    const apiRef = useRef<EmailEditorRef | null>(null);
    // Latest callbacks, readable from the one-time tiptap subscriptions below
    // without resubscribing on every render.
    const cbs = useRef({ onTextChange, onFocusChange, onCaretAtEndChange });
    cbs.current = { onTextChange, onFocusChange, onCaretAtEndChange };
    const autoFocusRef = useRef(autoFocus);

    const handleReady = useCallback((r: EmailEditorRef) => {
      apiRef.current = r;
      const ed = r.editor;
      if (!ed) return;
      if (autoFocusRef.current) ed.commands.focus(autoFocusRef.current);
      const sel = () => cbs.current.onCaretAtEndChange?.(caretAtEnd(ed));
      ed.on("focus", () => cbs.current.onFocusChange?.(true));
      ed.on("blur", () => cbs.current.onFocusChange?.(false));
      ed.on("selectionUpdate", sel);
      ed.on("update", () => {
        cbs.current.onTextChange?.(ed.getText());
        sel();
      });
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        async getEmail() {
          const r = apiRef.current;
          if (!r) return { html: "", text: "" };
          return r.getEmail();
        },
        getDocJson() {
          const r = apiRef.current;
          if (!r) return "";
          try {
            return JSON.stringify(r.getJSON());
          } catch {
            return "";
          }
        },
        setPlainText(text: string) {
          const ed = apiRef.current?.editor;
          if (!ed) return;
          // setContent does not reliably emit `update`; sync the mirror by hand.
          ed.commands.setContent(plainTextToHtml(text) || "<p></p>");
          cbs.current.onTextChange?.(ed.getText());
        },
        appendPlainText(text: string) {
          const ed = apiRef.current?.editor;
          if (!ed || !text) return;
          // Inserted as a TEXT node (not parsed HTML) so a Smart Compose
          // fragment continues the current paragraph instead of opening a new one.
          ed.chain()
            .focus("end")
            .insertContent({ type: "text", text })
            .run();
          cbs.current.onTextChange?.(ed.getText());
        },
        focus() {
          apiRef.current?.editor?.commands.focus("end");
        },
      }),
      [],
    );

    // Resume seed: the stored TipTap document when present (rich-faithful),
    // else plain text converted to simple HTML. A malformed/non-doc JSON seed
    // is ignored rather than risking a broken editor mount.
    let content: object | string | undefined = initialText ? plainTextToHtml(initialText) : undefined;
    const doc = parseEditorDoc(initialJson);
    if (doc) content = doc;

    return (
      <EmailEditor
        content={content}
        placeholder={placeholder}
        theme={NEUTRAL_EMAIL_THEME}
        onReady={handleReady}
        className={cn("compose-editor", className)}
      />
    );
  },
);

export default EmailBodyEditor;
