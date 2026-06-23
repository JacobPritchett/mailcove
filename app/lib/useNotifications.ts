import { useCallback, useEffect, useState } from "react";
import { pushSupported, getSubscription, enablePush, disablePush } from "./push";

/**
 * Drives the notifications toggle: tracks whether this device is subscribed to
 * Web Push and flips it on/off. `available` is false where push is unsupported
 * or permission was hard-denied (so the UI can hide the control).
 */
export function useNotifications() {
  const [supported] = useState(() => pushSupported());
  const [enabled, setEnabled] = useState(false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    if (typeof Notification !== "undefined" && Notification.permission === "denied") setDenied(true);
    getSubscription()
      .then((s) => setEnabled(!!s))
      .catch(() => {});
  }, [supported]);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setEnabled(false);
      } else {
        const result = await enablePush();
        if (result === "subscribed") setEnabled(true);
        else if (result === "denied") setDenied(true);
      }
    } catch {
      // Surface nothing destructive; leave state as-is so the user can retry.
    } finally {
      setBusy(false);
    }
  }, [busy, enabled]);

  return { available: supported && !denied, enabled, busy, denied, toggle };
}
