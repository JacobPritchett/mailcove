// An expired Cloudflare Access session: one persistent toast, a Reload that
// tries to save open drafts first, and nothing at all for plain offline errors.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { toast } from "sonner";
import { getMe, putDraft, send, ApiError } from "@/lib/api";
import { registerDraftFlush, page } from "@/lib/session";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
const lastInit = () => (fetchMock().mock.calls.at(-1)![1] ?? {}) as RequestInit;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The Reload action of the session toast. */
function reloadAction(): { onClick: () => void } {
  const options = vi.mocked(toast.error).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
  return options.action;
}

describe("api requests", () => {
  it("mark themselves as XHR so Access answers 401 instead of redirecting to its login page", async () => {
    fetchMock().mockResolvedValue(json({ email: "a@b.c" }));
    await getMe();
    expect((lastInit().headers as Record<string, string>)["X-Requested-With"]).toBe("XMLHttpRequest");

    fetchMock().mockImplementation(async () => json({ ok: true }));
    await putDraft("d1", { to: "", subject: "", bodyText: "", bodyJson: "" } as never);
    const headers = lastInit().headers as Record<string, string>;
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(headers["Content-Type"]).toBe("application/json");

    await send({ to: "x@y.z", subject: "", text: "" });
    expect((lastInit().headers as Record<string, string>)["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("do not follow redirects (an Access login redirect must be visible, not a CORS failure)", async () => {
    fetchMock().mockResolvedValue(json({ email: "a@b.c" }));
    await getMe();
    expect(lastInit().redirect).toBe("manual");
  });
});

describe("session expiry", () => {
  it("a 401 shows one persistent toast with a Reload action", async () => {
    fetchMock().mockResolvedValue(json({ error: "unauthorized" }, 401));
    await expect(getMe()).rejects.toMatchObject({ status: 401 });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Session expired. Reload to sign in again.",
      expect.objectContaining({
        id: "session-expired",
        duration: Infinity,
        action: expect.objectContaining({ label: "Reload" }),
      }),
    );
  });

  it("repeated 401s reuse the same toast id, so they do not stack", async () => {
    fetchMock().mockImplementation(async () => json({ error: "unauthorized" }, 401));
    await Promise.allSettled([getMe(), getMe(), getMe()]);
    const ids = vi.mocked(toast.error).mock.calls.map((c) => (c[1] as { id: string }).id);
    expect(new Set(ids)).toEqual(new Set(["session-expired"]));
  });

  it("an opaque redirect counts as an expired session", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 0, type: "opaqueredirect" } as Response);
    await expect(getMe()).rejects.toBeInstanceOf(ApiError);
    expect(toast.error).toHaveBeenCalledWith(
      "Session expired. Reload to sign in again.",
      expect.objectContaining({ id: "session-expired" }),
    );
  });

  it("treats the Worker's own auth rejection, and any 401 that is not a JSON error, as expiry", async () => {
    fetchMock().mockResolvedValue(json({ error: "unauthorized" }, 401));
    await expect(getMe()).rejects.toMatchObject({ status: 401 });
    // Cloudflare Access answering for itself: HTML, or nothing at all.
    fetchMock().mockResolvedValue(new Response("<html>Sign in</html>", { status: 401, headers: { "content-type": "text/html" } }));
    await expect(getMe()).rejects.toMatchObject({ status: 401 });
    fetchMock().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(getMe()).rejects.toMatchObject({ status: 401 });
    fetchMock().mockResolvedValue(json({ message: "no error field" }, 401));
    await expect(getMe()).rejects.toMatchObject({ status: 401 });
    expect(toast.error).toHaveBeenCalledTimes(4);
  });

  it("lets any other JSON 401 from the Worker through as an ordinary error", async () => {
    fetchMock().mockResolvedValue(json({ error: "bad webhook signature" }, 401));
    await expect(getMe()).rejects.toMatchObject({ status: 401, message: "bad webhook signature" });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says nothing for an ordinary network failure or another HTTP error", async () => {
    fetchMock().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(getMe()).rejects.toMatchObject({ status: 0 });
    fetchMock().mockResolvedValue(json({ error: "boom" }, 500));
    await expect(getMe()).rejects.toMatchObject({ status: 500 });
    fetchMock().mockResolvedValue(json({ error: "forbidden" }, 403));
    await expect(getMe()).rejects.toMatchObject({ status: 403 });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("Reload flushes open drafts first, and reloads even if a flush fails", async () => {
    const reload = vi.spyOn(page, "reload").mockImplementation(() => {});
    const order: string[] = [];
    const unregisterA = registerDraftFlush(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("saved");
    });
    const unregisterB = registerDraftFlush(() => Promise.reject(new Error("401")));
    reload.mockImplementation(() => { order.push("reload"); });

    fetchMock().mockResolvedValue(json({ error: "unauthorized" }, 401));
    await expect(getMe()).rejects.toBeInstanceOf(ApiError);
    reloadAction().onClick();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["saved", "reload"]);
    unregisterA();
    unregisterB();
  });

  it("does not wait forever on a flush that never settles", async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.spyOn(page, "reload").mockImplementation(() => {});
      const unregister = registerDraftFlush(() => new Promise(() => {}));
      fetchMock().mockResolvedValue(json({ error: "unauthorized" }, 401));
      await expect(getMe()).rejects.toBeInstanceOf(ApiError);
      reloadAction().onClick();
      await vi.advanceTimersByTimeAsync(5000);
      expect(reload).toHaveBeenCalledTimes(1);
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });
});
