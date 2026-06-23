import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useReaderMode } from "@/lib/useReaderMode";

describe("useReaderMode", () => {
  beforeEach(() => localStorage.clear());

  it("returns 'rich' by default", () => {
    const { result } = renderHook(() => useReaderMode());
    expect(result.current[0]).toBe("rich");
  });

  it("setter persists to localStorage", () => {
    const { result } = renderHook(() => useReaderMode());
    act(() => {
      result.current[1]("chat");
    });
    expect(localStorage.getItem("reader.viewMode")).toBe("chat");
  });

  it("a fresh renderHook picks up the persisted value", () => {
    const { result: r1 } = renderHook(() => useReaderMode());
    act(() => {
      r1.current[1]("chat");
    });
    const { result: r2 } = renderHook(() => useReaderMode());
    expect(r2.current[0]).toBe("chat");
  });
});
