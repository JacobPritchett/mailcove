import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock the API the hook calls.
vi.mock("@/lib/api", () => ({
  suggestCompletion: vi.fn(async (_s: string, _t: string) => ({ suggestion: " the rest" })),
}));

import { useComposeSuggestion } from "@/lib/useComposeSuggestion";
import { suggestCompletion } from "@/lib/api";

describe("useComposeSuggestion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(suggestCompletion).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("fetches a suggestion after the debounce when enabled", async () => {
    const { result } = renderHook(() => useComposeSuggestion("Subj", "Hello there friend", true));
    expect(result.current.suggestion).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(result.current.suggestion).toBe(" the rest");
    expect(suggestCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when disabled or the draft is too short", async () => {
    renderHook(() => useComposeSuggestion("S", "ok", false));
    renderHook(() => useComposeSuggestion("S", "ab", true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(suggestCompletion).not.toHaveBeenCalled();
  });

  it("clear() drops the current suggestion", async () => {
    const { result } = renderHook(() => useComposeSuggestion("S", "Hello there friend", true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(result.current.suggestion).toBe(" the rest");
    act(() => result.current.clear());
    expect(result.current.suggestion).toBe("");
  });
});
