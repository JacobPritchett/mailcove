/**
 * Should a keydown handler leave this key alone?
 *
 * True while an IME is composing: Enter there commits the composition, it is
 * not a command (and Cmd/Ctrl+Enter mid-composition would send half a word).
 * `isComposing` is the standard signal; Safari fires the committing keydown
 * with it already false, and reports it as keyCode 229 instead. True too when
 * another handler has already dealt with the key.
 */
export function keyIsSpokenFor(e: {
  defaultPrevented: boolean;
  keyCode: number;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
}): boolean {
  return e.defaultPrevented || composing(e);
}

/** IME composition only (for handlers that run first and cannot be pre-empted). */
export function composing(e: {
  keyCode: number;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
}): boolean {
  return (e.nativeEvent?.isComposing ?? e.isComposing ?? false) || e.keyCode === 229;
}
