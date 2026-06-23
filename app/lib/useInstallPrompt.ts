import { useCallback, useEffect, useState } from "react";
import { type BeforeInstallPromptEvent, isStandalone } from "./pwa";

/**
 * Captures the browser's `beforeinstallprompt` event so the app can offer its
 * own "Install" affordance. Returns `canInstall` (an install prompt is pending
 * and we're not already installed) and `promptInstall()` which shows it.
 *
 * Browsers that don't fire the event (iOS Safari, or already-installed) leave
 * `canInstall` false — callers simply don't render the button there.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (isStandalone()) {
      setInstalled(true);
      return;
    }
    function onBeforeInstall(e: Event) {
      e.preventDefault(); // stop Chrome's mini-infobar; we drive the prompt
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setDeferred(null);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // The event can only be used once; drop it regardless of choice.
    setDeferred(null);
    return outcome;
  }, [deferred]);

  return { canInstall: !installed && deferred !== null, installed, promptInstall };
}
