// The inbox's unread count where it can be seen without the app in front:
// the tab title, and the icon badge of an installed app.
import { useEffect, useRef } from "react";

/** "(3) Inbox" with unread mail, the app's own title with none. */
export function unreadTitle(unread: number, base: string): string {
  return unread > 0 ? `(${unread}) Inbox` : base;
}

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Set or clear the installed app's icon badge. Feature-detected, and every
 * failure is swallowed: the Badging API is missing in most browsers, and where
 * it exists it can reject (no permission, not installed). A badge is never
 * worth an error.
 */
export function setUnreadBadge(unread: number): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as BadgeNavigator;
  try {
    if (unread > 0) {
      if (typeof nav.setAppBadge === "function") void nav.setAppBadge(unread).catch(() => {});
    } else if (typeof nav.clearAppBadge === "function") {
      void nav.clearAppBadge().catch(() => {});
    }
  } catch {
    // A synchronous throw from a partial implementation: same answer.
  }
}

/**
 * Keep the tab title and app badge in step with the inbox's unread count.
 * `undefined` (the count has not loaded, or its request failed) changes
 * nothing: a count we do not have must not be shown as zero.
 */
export function useUnreadBadge(unread: number | undefined): void {
  // The title the page came with, to go back to at zero.
  const base = useRef<string | null>(null);
  useEffect(() => {
    if (unread === undefined || typeof document === "undefined") return;
    if (base.current === null) base.current = document.title;
    document.title = unreadTitle(unread, base.current);
    setUnreadBadge(unread);
  }, [unread]);
  useEffect(
    () => () => {
      if (base.current !== null) document.title = base.current;
    },
    [],
  );
}
