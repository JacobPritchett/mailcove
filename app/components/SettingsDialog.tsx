// Choices kept in this browser, not on the server: how long a sent message
// can still be taken back, and whether email links on the web open here.
import { useState } from "react";
import { Mail, Settings } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { setUndoSendSeconds, UNDO_SEND_CHOICES, useUndoSendSeconds } from "@/lib/outbox";
import { canRegisterMailto, registerMailtoHandler } from "@/lib/mailtoHandler";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const seconds = useUndoSendSeconds();
  // The browser never says whether the user agreed to its own prompt, so this
  // only records that it was asked, to change what the button says next.
  const [asked, setAsked] = useState(false);

  function registerMailto() {
    if (registerMailtoHandler()) {
      setAsked(true);
      toast("Your browser will ask to confirm. After that, email links open a new message here.");
    } else {
      toast.error("This browser did not allow it. Look for an email links setting in the browser itself.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 max-md:h-[100dvh] max-md:max-h-[100dvh] max-md:max-w-full max-md:rounded-none sm:max-w-md">
        <DialogHeader className="space-y-1 border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" /> Settings
          </DialogTitle>
          <DialogDescription>These are kept in this browser only.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section aria-labelledby="settings-undo-send">
            <h3 id="settings-undo-send" className="text-sm font-medium">
              Undo send
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              How long a message waits after you press Send, so you can take it back. Messages with
              attachments are sent at once.
            </p>
            <div role="radiogroup" aria-labelledby="settings-undo-send" className="mt-3 flex flex-wrap gap-1.5">
              {UNDO_SEND_CHOICES.map((choice) => {
                const active = choice === seconds;
                return (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setUndoSendSeconds(choice)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-sm font-medium transition-colors max-md:min-h-11 max-md:px-4",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {choice === 0 ? "Off" : `${choice} seconds`}
                  </button>
                );
              })}
            </div>
          </section>

          {canRegisterMailto() && (
            <>
              <Separator />
              <section aria-labelledby="settings-mailto">
                <h3 id="settings-mailto" className="text-sm font-medium">
                  Email links
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Open email links from other websites as a new message here. A link only fills in the
                  message. Nothing is sent until you press Send.
                </p>
                <Button type="button" variant="outline" size="sm" onClick={registerMailto} className="mt-3 gap-1.5 max-md:h-11">
                  <Mail className="size-4" />
                  {asked ? "Ask again" : "Open email links here"}
                </Button>
              </section>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
