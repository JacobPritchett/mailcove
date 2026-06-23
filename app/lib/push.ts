// Frontend Web Push: subscribe/unsubscribe this device against the service
// worker's PushManager and sync the subscription with the Worker.

import { getPushKey, pushSubscribe, pushUnsubscribe } from "./api";

/** Whether this browser supports the APIs Web Push needs. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Decode a base64url VAPID key to the Uint8Array applicationServerKey wants. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Whether a subscription was created with the given applicationServerKey. */
function sameApplicationServerKey(sub: PushSubscription, key: Uint8Array): boolean {
  const existing = sub.options?.applicationServerKey;
  if (!existing) return false;
  const a = new Uint8Array(existing as ArrayBuffer);
  if (a.length !== key.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
  return true;
}

/** Current push subscription for this device, or null. */
export async function getSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export type EnableResult = "subscribed" | "denied" | "unsupported";

/**
 * Request notification permission, subscribe via the SW push manager, and
 * register the subscription with the Worker. Idempotent — reuses an existing
 * browser subscription if present.
 */
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const { key } = await getPushKey();
  const appKey = urlBase64ToUint8Array(key);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // If an existing subscription was created with a different VAPID key (e.g. the
  // server rotated keys), it can't receive our pushes — drop and re-subscribe.
  if (sub && !sameApplicationServerKey(sub, appKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub =
    sub ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appKey as BufferSource,
    }));
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!sub.endpoint || !p256dh || !auth) throw new Error("incomplete push subscription");
  await pushSubscribe(sub.endpoint, { p256dh, auth });
  return "subscribed";
}

/** Unsubscribe this device locally and on the Worker. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  // Tell the server first (we still have the endpoint), then drop locally.
  await pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
