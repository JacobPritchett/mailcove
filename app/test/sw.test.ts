// The service worker's notification-click contract. sw.js is a plain script
// (not a module), so it is evaluated here against a fake `self`.
import { describe, it, expect, vi, beforeEach } from "vitest";
// Vite's ?raw gives the file's text (the app tsconfig has no node types for fs).
import SOURCE from "../../public/sw.js?raw";

type Listener = (event: Record<string, unknown>) => void;

function loadWorker(windows: unknown[]) {
  const listeners: Record<string, Listener> = {};
  const self = {
    location: { origin: "https://inbox.test" },
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: {
      matchAll: vi.fn(() => Promise.resolve(windows)),
      openWindow: vi.fn(() => Promise.resolve(null)),
      claim: vi.fn(),
    },
  };
  new Function("self", "caches", SOURCE)(self, {});
  return { self, listeners };
}

/** Dispatch an event and wait for everything it passed to waitUntil. */
async function dispatch(listener: Listener, event: Record<string, unknown>) {
  const pending: Promise<unknown>[] = [];
  listener({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

function windowClient() {
  return {
    focus: vi.fn(() => Promise.resolve()),
    navigate: vi.fn(() => Promise.resolve()),
    postMessage: vi.fn(),
  };
}

const click = (data: unknown) => ({ notification: { close: vi.fn(), data } });

beforeEach(() => vi.clearAllMocks());

describe("push", () => {
  it("carries the thread id from the payload onto the notification", async () => {
    const { self, listeners } = loadWorker([]);
    await dispatch(listeners.push, {
      data: { json: () => ({ title: "Alice", body: "hi", threadId: "t-42" }) },
    });
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "Alice",
      expect.objectContaining({ data: expect.objectContaining({ threadId: "t-42" }) }),
    );
  });

  it("tolerates a payload with no thread id", async () => {
    const { self, listeners } = loadWorker([]);
    await dispatch(listeners.push, { data: { json: () => ({ title: "Alice" }) } });
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
  });
});

describe("the Worker's payload", () => {
  // Exactly what src/index.ts builds for sendPushToAll: title, body, url and
  // tag always; threadId only when the id fits un-truncated (tag is the same
  // id clamped to 512 bytes).
  const workerPayload = (threadId: string, withThreadId = true) => ({
    title: "Alice",
    body: "Lunch on Friday?",
    url: "/",
    tag: threadId.slice(0, 512),
    ...(withThreadId ? { threadId } : {}),
  });

  async function pushThenClick(payload: Record<string, string>, windows: unknown[] = []) {
    const { self, listeners } = loadWorker(windows);
    await dispatch(listeners.push, { data: { json: () => payload } });
    const [title, options] = self.registration.showNotification.mock.calls[0] as unknown as [
      string,
      { tag: string; data: unknown },
    ];
    await dispatch(listeners.notificationclick, click(options.data));
    return { self, title, options };
  }

  it("opens the thread named by threadId", async () => {
    const { self, title, options } = await pushThenClick(workerPayload("<root@mail.example>"));
    expect(title).toBe("Alice");
    expect(options.tag).toBe("<root@mail.example>");
    expect(self.clients.openWindow).toHaveBeenCalledWith("/?thread=%3Croot%40mail.example%3E");
  });

  it("falls back to tag as the thread id when threadId is absent (older Worker)", async () => {
    const client = windowClient();
    await pushThenClick(workerPayload("<root@mail.example>", false), [client]);
    expect(client.postMessage).toHaveBeenCalledWith({ type: "open-thread", threadId: "<root@mail.example>" });
  });

  it("does not use a tag that was clamped: a truncated id opens nothing useful", async () => {
    const { self } = await pushThenClick(workerPayload("x".repeat(600), false));
    expect(self.clients.openWindow).toHaveBeenCalledWith("/");
  });

  it("does not mistake a missing tag for a thread", async () => {
    const { self } = await pushThenClick({ title: "Alice", body: "hi", url: "/" });
    expect(self.clients.openWindow).toHaveBeenCalledWith("/");
  });
});

describe("notification click", () => {
  it("focuses an open window and asks it to open the thread, without navigating it", async () => {
    const client = windowClient();
    const { self, listeners } = loadWorker([client]);
    await dispatch(listeners.notificationclick, click({ threadId: "t-42" }));

    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(client.postMessage).toHaveBeenCalledWith({ type: "open-thread", threadId: "t-42" });
    // Navigating reloads the app and throws away a compose in progress.
    expect(client.navigate).not.toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("only focuses when the notification has no thread id", async () => {
    const client = windowClient();
    const { listeners } = loadWorker([client]);
    await dispatch(listeners.notificationclick, click({ url: "/" }));
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(client.postMessage).not.toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
  });

  it("opens a new window at the thread when none is open", async () => {
    const { self, listeners } = loadWorker([]);
    await dispatch(listeners.notificationclick, click({ threadId: "<a b@c>" }));
    expect(self.clients.openWindow).toHaveBeenCalledWith("/?thread=%3Ca%20b%40c%3E");
  });

  it("opens the app root when there is no thread id or no data at all", async () => {
    const { self, listeners } = loadWorker([]);
    await dispatch(listeners.notificationclick, click(undefined));
    expect(self.clients.openWindow).toHaveBeenCalledWith("/");
  });
});
