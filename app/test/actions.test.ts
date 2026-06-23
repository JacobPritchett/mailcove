import { describe, it, expect } from "vitest";
import { actionLabel, isReversible } from "@/lib/actions";

describe("actionLabel", () => {
  it('archive → "Archived"', () => {
    expect(actionLabel("archive")).toBe("Archived");
  });
  it('unarchive → "Moved to Inbox"', () => {
    expect(actionLabel("unarchive")).toBe("Moved to Inbox");
  });
  it('trash → "Moved to Trash"', () => {
    expect(actionLabel("trash")).toBe("Moved to Trash");
  });
  it('restore → "Restored"', () => {
    expect(actionLabel("restore")).toBe("Restored");
  });
  it('delete → "Deleted forever"', () => {
    expect(actionLabel("delete")).toBe("Deleted forever");
  });
  it('star → "Starred"', () => {
    expect(actionLabel("star")).toBe("Starred");
  });
  it('unstar → "Unstarred"', () => {
    expect(actionLabel("unstar")).toBe("Unstarred");
  });
  it('read → "Marked read"', () => {
    expect(actionLabel("read")).toBe("Marked read");
  });
  it('unread → "Marked unread"', () => {
    expect(actionLabel("unread")).toBe("Marked unread");
  });
});

describe("isReversible", () => {
  it("delete is NOT reversible", () => {
    expect(isReversible("delete")).toBe(false);
  });
  it("archive IS reversible", () => {
    expect(isReversible("archive")).toBe(true);
  });
  it("trash IS reversible", () => {
    expect(isReversible("trash")).toBe(true);
  });
  it("star IS reversible", () => {
    expect(isReversible("star")).toBe(true);
  });
  it("unstar IS reversible", () => {
    expect(isReversible("unstar")).toBe(true);
  });
  it("read IS reversible", () => {
    expect(isReversible("read")).toBe(true);
  });
  it("unread IS reversible", () => {
    expect(isReversible("unread")).toBe(true);
  });
});
