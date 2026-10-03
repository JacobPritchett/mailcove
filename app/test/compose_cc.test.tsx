// Cc and Bcc in the compose dialog: hidden until wanted, sent when filled,
// never silently dropped, and kept by a draft.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ComposeDialog, { type ComposeInitial } from "../components/ComposeDialog";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  getIdentities: vi.fn(() =>
    Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
  ),
  send: vi.fn(() => Promise.resolve({ ok: true, id: "sent-1" })),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  putDraftAttachments: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  suggestCompletion: vi.fn(() => Promise.resolve({ suggestion: "" })),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));

import { send, putDraft } from "../lib/api";

function open(initial?: ComposeInitial) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ComposeDialog open onOpenChange={() => {}} initial={initial} />
    </QueryClientProvider>,
  );
}

const sendButton = () => screen.getByRole("button", { name: /^send$/i });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  vi.mocked(send).mockClear();
  vi.mocked(putDraft).mockClear();
});

describe("compose Cc and Bcc", () => {
  it("keeps both rows out of the way until asked for", () => {
    open();
    expect(screen.queryByLabelText("Add Cc recipient")).toBeNull();
    expect(screen.queryByLabelText("Add Bcc recipient")).toBeNull();
    expect(screen.getByRole("button", { name: "Cc" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bcc" })).toBeTruthy();
  });

  it("sends typed Cc and Bcc, including an uncommitted trailing address", async () => {
    open({ to: "a@example.com", subject: "hi" });
    click("Cc");
    type("Add Cc recipient", "c1@example.com, c2@example.com");
    click("Bcc");
    type("Add Bcc recipient", "hidden@example.com");
    fireEvent.click(sendButton());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(send).mock.calls[0][0];
    expect(payload.to).toEqual(["a@example.com"]);
    expect(payload.cc).toEqual(["c1@example.com", "c2@example.com"]);
    expect(payload.bcc).toEqual(["hidden@example.com"]);
  });

  it("omits cc and bcc when there are none", async () => {
    open({ to: "a@example.com", subject: "hi" });
    fireEvent.click(sendButton());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(send).mock.calls[0][0];
    expect("cc" in payload).toBe(false);
    expect("bcc" in payload).toBe(false);
  });

  it("refuses to send with a malformed Cc rather than dropping it", async () => {
    open({ to: "a@example.com", subject: "hi" });
    click("Cc");
    type("Add Cc recipient", "not-an-address");
    fireEvent.submit(sendButton().closest("form")!);
    await screen.findByText(/Not a valid email: not-an-address/);
    expect(send).not.toHaveBeenCalled();
  });

  it("opens the rows a reply-all or a resumed draft brings recipients for", () => {
    open({ to: "a@example.com", cc: "c@example.com, d@example.com", subject: "Re: hi" });
    expect(screen.getByText("c@example.com")).toBeTruthy();
    expect(screen.getByText("d@example.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cc" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bcc" })).toBeTruthy();
  });

  it("does not send when Enter is pressed in a Cc field", async () => {
    open({ to: "a@example.com", subject: "hi" });
    click("Cc");
    type("Add Cc recipient", "c@example.com");
    fireEvent.keyDown(screen.getByLabelText("Add Cc recipient"), { key: "Enter" });
    expect(screen.getByText("c@example.com")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("saves Cc and Bcc with the draft", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open({ to: "a@example.com" });
      click("Bcc");
      type("Add Bcc recipient", "hidden@example.com,");
      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(putDraft).toHaveBeenCalled());
      const body = vi.mocked(putDraft).mock.calls.at(-1)![1];
      expect(body.bcc).toBe("hidden@example.com");
      expect(body.cc).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
