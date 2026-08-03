// jsdom stand-in for the rich body editor (aliased in vitest.config.ts).
// ProseMirror needs real DOM ranges, so component tests drive a plain
// textarea implementing the exact ComposeBodyHandle contract instead — compose
// logic (mirror sync, suggestion accept, AI draft, send serialization) stays
// fully testable.
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ComposeBodyHandle, EmailBodyEditorProps } from "../../components/EmailBodyEditor";

/**
 * What the real editor does to a plain-text seed, as far as the mirror can see.
 *
 * plainTextToHtml turns "> " lines into a <blockquote>, so getText() hands them
 * back WITHOUT the markers. A mock that echoes setPlainText verbatim makes
 * every "is the body still exactly what we seeded?" check trivially true, which
 * hid a junk-draft regression and a draft-clobbering bug from the suite.
 */
function roundTrip(text: string): string {
  return text.replace(/^[ \t]*>[ \t]?/gm, "");
}

const EmailBodyEditorMock = forwardRef<ComposeBodyHandle, EmailBodyEditorProps>(
  function EmailBodyEditorMock(
    { initialText, initialJson, placeholder, onTextChange, onFocusChange, onCaretAtEndChange, autoFocus },
    ref,
  ) {
    const taRef = useRef<HTMLTextAreaElement>(null);

    // Round-trippable doc format for tests: {"mockText": "..."} — what
    // getDocJson emits is what initialJson restores.
    let seed = roundTrip(initialText ?? "");
    if (initialJson) {
      try {
        const doc = JSON.parse(initialJson) as { mockText?: string };
        if (typeof doc.mockText === "string") seed = doc.mockText;
      } catch {
        // keep plain seed
      }
    }

    useImperativeHandle(ref, () => ({
      async getEmail() {
        const v = taRef.current?.value ?? "";
        return { html: v ? `<p>${v}</p>` : "", text: v };
      },
      getDocJson() {
        return JSON.stringify({ mockText: taRef.current?.value ?? "" });
      },
      setPlainText(text: string) {
        const v = roundTrip(text);
        if (taRef.current) taRef.current.value = v;
        onTextChange?.(v);
      },
      appendPlainText(text: string) {
        if (taRef.current) taRef.current.value += text;
        onTextChange?.(taRef.current?.value ?? "");
      },
      focus() {
        taRef.current?.focus();
      },
    }));

    return (
      <textarea
        ref={taRef}
        aria-label="Message"
        placeholder={placeholder}
        autoFocus={!!autoFocus}
        defaultValue={seed}
        onChange={(e) => {
          onTextChange?.(e.target.value);
          onCaretAtEndChange?.(true);
        }}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
      />
    );
  },
);

export default EmailBodyEditorMock;
