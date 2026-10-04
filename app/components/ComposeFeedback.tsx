import { useUndoSendSeconds } from "@/lib/outbox";
export type SaveState = "idle" | "unsaved" | "saving" | "saved" | "partial" | "local" | "failed";
export function DraftSaveStatus({ state, retry, disabled }: { state: SaveState; retry: () => void; disabled?: boolean }) {
  return <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
    <span role="status" aria-live="polite">{({ idle: "", unsaved: "Unsaved changes", saving: "Saving draft…", saved: "Draft saved", partial: "Draft text saved. Attachments are still loading or need to be saved.", local: "Couldn't save to server. Recovery copy is in Drafts on this device.", failed: "Couldn't save a recovery copy. Keep this message open or copy its contents." })[state]}</span>
    {(state === "local" || state === "failed") && <button type="button" disabled={disabled} onClick={retry} className="underline disabled:opacity-50">Retry saving</button>}
  </div>;
}
export function SendTiming({ attachments = false, available = true }: { attachments?: boolean; available?: boolean }) {
  const seconds = useUndoSendSeconds();
  return <p className="px-4 py-2 text-xs text-muted-foreground" role="note">
    {!seconds || !available ? "Sends immediately. Undo send is unavailable." : attachments ?
      "Sends immediately because files are attached. Undo send is unavailable." :
      `Undo send: up to ${seconds} seconds. Switching tabs or leaving this page sends sooner. Large messages send immediately.`}
  </p>;
}
