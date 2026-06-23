import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useInstallPrompt } from "@/lib/useInstallPrompt";
import { isStandalone } from "@/lib/pwa";

/** Build a fake beforeinstallprompt event with the extra PWA methods. */
function makeBipEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const e = new Event("beforeinstallprompt") as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  e.prompt = vi.fn(async () => {});
  e.userChoice = Promise.resolve({ outcome });
  return e;
}

describe("isStandalone", () => {
  it("is false in the test environment (not installed)", () => {
    expect(isStandalone()).toBe(false);
  });
});

describe("useInstallPrompt", () => {
  it("starts not installable, becomes installable after beforeinstallprompt", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(false);

    const ev = makeBipEvent();
    act(() => {
      window.dispatchEvent(ev);
    });
    await waitFor(() => expect(result.current.canInstall).toBe(true));
  });

  it("prompts on demand and clears installability after a choice", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const ev = makeBipEvent("accepted");
    act(() => {
      window.dispatchEvent(ev);
    });
    await waitFor(() => expect(result.current.canInstall).toBe(true));

    await act(async () => {
      const outcome = await result.current.promptInstall();
      expect(outcome).toBe("accepted");
    });
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    expect(result.current.canInstall).toBe(false); // one-shot event consumed
  });

  it("appinstalled marks installed and hides the prompt", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(makeBipEvent());
    });
    await waitFor(() => expect(result.current.canInstall).toBe(true));

    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    await waitFor(() => expect(result.current.installed).toBe(true));
    expect(result.current.canInstall).toBe(false);
  });
});
