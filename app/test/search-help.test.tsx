/**
 * The search box's operator hint: when it shows, what clicking one does, and
 * dismissing it for good.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import SearchField, { SEARCH_OPERATORS } from "../components/SearchField";

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <SearchField value={value} onChange={setValue} label="Search messages" />
      <button type="button">elsewhere</button>
    </>
  );
}
const input = () => screen.getByLabelText("Search messages") as HTMLInputElement;
const tips = () => screen.queryByRole("group", { name: "Search operators" });

beforeEach(() => {
  localStorage.clear();
});

describe("when the hint shows", () => {
  it("is hidden until the box is focused", () => {
    render(<Harness />);
    expect(tips()).toBeNull();
    act(() => input().focus());
    expect(tips()).toBeInTheDocument();
  });

  it("goes away once something is typed, and comes back when the box is emptied", () => {
    render(<Harness />);
    act(() => input().focus());
    fireEvent.change(input(), { target: { value: "inv" } });
    expect(tips()).toBeNull();
    fireEvent.change(input(), { target: { value: "" } });
    expect(tips()).toBeInTheDocument();
  });

  it("closes when focus leaves the search box altogether, and not when it moves into the hint", () => {
    render(<Harness />);
    act(() => input().focus());
    const first = within(tips()!).getAllByRole("button")[1];
    act(() => first.focus());
    expect(tips()).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "elsewhere" }).focus());
    expect(tips()).toBeNull();
  });

  it("lists every operator the Worker understands, with an example and what it means", () => {
    render(<Harness />);
    act(() => input().focus());
    const names = within(tips()!).getAllByRole("button").map((b) => b.textContent);
    for (const op of ["from:", "to:", "cc:", "subject:", "has:attachment", "is:unread", "in:", "before:", "after:", "older_than:", "newer_than:", "domain:", "-", '"']) {
      expect(names.some((n) => n?.startsWith(op))).toBe(true);
    }
    expect(screen.getByRole("button", { name: "from:anna From a sender" })).toBeInTheDocument();
    // One example per operator.
    expect(new Set(SEARCH_OPERATORS.map((o) => o.insert)).size).toBe(SEARCH_OPERATORS.length);
  });
});

describe("clicking an operator", () => {
  it("puts the operator in the box, ready for its value, and keeps the box focused", () => {
    render(<Harness />);
    act(() => input().focus());
    fireEvent.click(screen.getByRole("button", { name: /^from:anna/ }));
    expect(input().value).toBe("from:");
    expect(input()).toHaveFocus();
    expect(input().selectionStart).toBe(5);
    // The box is no longer empty, so the hint is out of the way.
    expect(tips()).toBeNull();
  });

  it("inserts a complete term whole", () => {
    render(<Harness />);
    act(() => input().focus());
    fireEvent.click(screen.getByRole("button", { name: /^has:attachment/ }));
    expect(input().value).toBe("has:attachment ");
  });

  it("leaves the caret between the quotes of a phrase", () => {
    render(<Harness />);
    act(() => input().focus());
    fireEvent.click(screen.getByRole("button", { name: /^"exact phrase"/ }));
    expect(input().value).toBe('""');
    expect(input().selectionStart).toBe(1);
    expect(input().selectionEnd).toBe(1);
  });

  it("does not take focus from the box on the way (a mousedown there is cancelled)", () => {
    render(<Harness />);
    act(() => input().focus());
    const down = fireEvent.mouseDown(screen.getByRole("button", { name: /^from:anna/ }));
    // fireEvent returns false when the event was cancelled.
    expect(down).toBe(false);
  });
});

describe("dismissing", () => {
  it("hides the hint for good, and the help button brings it back", () => {
    const { unmount } = render(<Harness />);
    act(() => input().focus());
    fireEvent.click(screen.getByRole("button", { name: "Hide search tips" }));
    expect(tips()).toBeNull();
    expect(input()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Search tips" })).toHaveAttribute("aria-pressed", "false");

    // Remembered across a reload.
    unmount();
    render(<Harness />);
    act(() => input().focus());
    expect(tips()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Search tips" }));
    expect(tips()).toBeInTheDocument();
    expect(input()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Search tips" })).toHaveAttribute("aria-pressed", "true");
  });
});
