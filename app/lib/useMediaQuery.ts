import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 *
 * Used for the small amount of mobile/desktop branching that can't be expressed
 * with Tailwind responsive classes alone — specifically the mobile list⇄reader
 * back navigation, where the "back" affordance only exists below `md`. Pane
 * visibility itself is driven by responsive classes; this hook only gates the
 * tiny JS state that those classes can't reach.
 *
 * SSR/test safety: defaults to `false` when `matchMedia` is unavailable. The
 * listener is registered on mount and cleaned up on unmount, so there are no
 * window-resize hacks and no leaked listeners.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Sync once in case the query changed between render and effect.
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Tailwind `md` breakpoint (≥768px) = "desktop"; below it = "mobile". */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px)");
}
