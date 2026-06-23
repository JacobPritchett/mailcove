import { useCallback, useEffect, useRef, useState } from "react";
import { suggestCompletion } from "./api";

/** Debounce (ms) after typing stops before asking the model for a continuation. */
const DEBOUNCE_MS = 600;
/** Don't bother suggesting until there's at least this much draft. */
const MIN_CHARS = 3;

/**
 * Smart Compose: returns a short AI continuation of the current draft, fetched
 * after the user pauses typing. The suggestion is cleared immediately on any
 * change to `subject`/`text` (so a stale completion never lingers) and the
 * in-flight request is aborted when inputs change or the hook disables.
 *
 * `enabled` gates fetching (e.g. only while the body is focused). `clear()` lets
 * the caller dismiss a suggestion (Esc, or after accepting it).
 */
export function useComposeSuggestion(subject: string, text: string, enabled: boolean) {
  const [suggestion, setSuggestion] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const clear = useCallback(() => setSuggestion(""), []);

  useEffect(() => {
    // Any input change invalidates the previous suggestion right away.
    setSuggestion("");
    abortRef.current?.abort();
    if (!enabled || text.trim().length < MIN_CHARS) return;

    const timer = setTimeout(() => {
      const ac = new AbortController();
      abortRef.current = ac;
      suggestCompletion(subject, text, ac.signal)
        .then((res) => {
          if (!ac.signal.aborted) setSuggestion(res.suggestion || "");
        })
        .catch(() => {
          // Aborted or failed → just no suggestion. Never surface an error.
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [subject, text, enabled]);

  return { suggestion, clear };
}
