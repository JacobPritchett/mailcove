import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { keepRecovery, clearRecovery, useRecoveryDrafts, type RecoveryDraft } from "../lib/draftRecovery";
import { sendFeedback } from "../lib/sendFeedback";
function View() { return <div>{useRecoveryDrafts().map(d => <span key={d.id}>{d.payload.subject}</span>)}</div>; }
const draft = (revision: string, subject: string): RecoveryDraft => ({ id: "draft-1", revision, updated: 1, payload: { subject, fromName: "Chosen", bodyText: "hello" }, attachments: [] });
beforeEach(() => localStorage.clear());
describe("draft recovery", () => {
  it("a late save cannot clear a newer recovery copy", () => {
    keepRecovery(draft("old", "old"));
    keepRecovery(draft("new", "new"));
    clearRecovery("draft-1", "old");
    render(<View />);
    expect(screen.getByText("new")).toBeInTheDocument();
  });
  it("removes a matching saved or discarded copy", () => {
    keepRecovery(draft("v1", "saved"));
    clearRecovery("draft-1", "v1");
    render(<View />);
    expect(screen.queryByText("saved")).not.toBeInTheDocument();
  });
  it("reports storage failure instead of claiming recovery is available", () => {
    const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(keepRecovery(draft("v1", "too large"))).toBe(false);
    fail.mockRestore();
  });
  it("ignores malformed recovery records", () => {
    localStorage.setItem("mailcove.draft-recovery", JSON.stringify([{ ...draft("v1", "bad"), payload: { subject: {} } }]));
    render(<View />);
    expect(screen.queryByText("bad")).not.toBeInTheDocument();
  });
});
it("distinguishes a rejection from an uncertain send outcome", () => {
  expect(sendFeedback(Object.assign(new Error("Invalid sender"), { status: 400 }))).toContain("Message not sent. Invalid sender");
  expect(sendFeedback(new TypeError("Failed to fetch"))).toContain("Check Sent before trying again");
  expect(sendFeedback(Object.assign(new Error("Gateway error"), { status: 502 }))).toContain("Check Sent before trying again");
});
