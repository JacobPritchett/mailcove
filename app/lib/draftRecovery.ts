// Local recovery copies live until the matching server save succeeds. A late
// save must never erase a newer snapshot of the same draft.
import { useSyncExternalStore } from "react";
import type { DraftPut } from "./types";
import type { StagedAttachment } from "./attachments";
const KEY = "mailcove.draft-recovery";
const listeners = new Set<() => void>();
export interface RecoveryDraft {
  id: string;
  revision: string;
  updated: number;
  payload: DraftPut;
  /** null means stored attachments still need to be fetched from the server. */
  attachments: StagedAttachment[] | null;
  pendingAttachments?: StagedAttachment[];
}
const raw = () => { try { return localStorage.getItem(KEY) ?? "[]"; } catch { return "[]"; } };
function validAttachments(value: unknown): value is StagedAttachment[] {
  return Array.isArray(value) && value.every(a => a && typeof a.name === "string" &&
    typeof a.type === "string" && typeof a.data === "string" && Number.isFinite(a.size));
}
function parse(value: string): RecoveryDraft[] {
  try {
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is RecoveryDraft => {
      if (!r || typeof r !== "object") return false;
      const d = r as RecoveryDraft;
      return typeof d.id === "string" && typeof d.revision === "string" && Number.isFinite(d.updated) &&
        !!d.payload && typeof d.payload === "object" && Object.values(d.payload).every(v => typeof v === "string") &&
        (d.attachments === null || validAttachments(d.attachments)) &&
        (d.pendingAttachments === undefined || validAttachments(d.pendingAttachments));
    });
  } catch { return []; }
}
function write(rows: RecoveryDraft[]): boolean {
  try {
    if (rows.length) localStorage.setItem(KEY, JSON.stringify(rows));
    else localStorage.removeItem(KEY);
    listeners.forEach(fn => fn());
    return true;
  } catch { return false; }
}
export function keepRecovery(draft: RecoveryDraft): boolean {
  return write([...parse(raw()).filter(d => d.id !== draft.id), draft]);
}
export function clearRecovery(id: string, revision?: string): void {
  write(parse(raw()).filter(d => d.id !== id || (revision !== undefined && d.revision !== revision)));
}
export function useRecoveryDrafts(): RecoveryDraft[] {
  const value = useSyncExternalStore(fn => {
    listeners.add(fn);
    const changed = (e: StorageEvent) => { if (e.key === KEY || e.key === null) fn(); };
    window.addEventListener("storage", changed);
    return () => { listeners.delete(fn); window.removeEventListener("storage", changed); };
  }, raw, () => "[]");
  return parse(value);
}
