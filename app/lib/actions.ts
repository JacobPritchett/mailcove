import type { MailAction } from "./types";

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
};

export function actionLabel(a: MailAction): string {
  return PAST[a];
}

export function isReversible(a: MailAction): boolean {
  return a !== "delete";
}
