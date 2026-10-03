import type { MailAction, View } from "./types";

const PAST: Record<MailAction, string> = {
  archive:   "Archived",
  unarchive: "Moved to Inbox",
  trash:     "Moved to Trash",
  restore:   "Restored",
  delete:    "Deleted forever",
  star:      "Starred",
  unstar:    "Unstarred",
  read:      "Marked read",
  unread:    "Marked unread",
  spam:      "Moved to Junk",
  unspam:    "Marked as not junk",
  snooze:    "Snoozed",
  unsnooze:  "Unsnoozed",
};

const FAILED: Record<MailAction, string> = {
  archive:   "Couldn't archive",
  unarchive: "Couldn't move to Inbox",
  trash:     "Couldn't move to Trash",
  restore:   "Couldn't restore",
  delete:    "Couldn't delete",
  star:      "Couldn't star",
  unstar:    "Couldn't unstar",
  read:      "Couldn't mark read",
  unread:    "Couldn't mark unread",
  spam:      "Couldn't move to Junk",
  unspam:    "Couldn't mark as not junk",
  snooze:    "Couldn't snooze",
  unsnooze:  "Couldn't unsnooze",
};

export function actionLabel(a: MailAction): string {
  return PAST[a];
}

/** What to say when the server rejected an action (no trailing punctuation). */
export function actionFailedLabel(a: MailAction): string {
  return FAILED[a];
}

/**
 * The view whose rules apply to the threads on screen. Search is global and
 * excludes trash, so while a query is active the results are live mail from
 * anywhere, whichever view is selected in the sidebar: offering Restore and
 * Delete forever on them (because the sidebar says Trash) is simply wrong.
 */
export function actionView(view: View, q?: string): View {
  return q?.trim() ? "all" : view;
}

export function isReversible(a: MailAction): boolean {
  return a !== "delete";
}
