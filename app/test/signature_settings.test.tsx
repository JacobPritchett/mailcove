// Two things nothing pinned before: that saving a signature refreshes the cache
// compose actually reads from, and that a seeded signature is not mistaken for
// content the user wrote. Both were real bugs.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import type { ThreadsResponse, Me } from "../lib/types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(),
  getIdentities: vi.fn(),
  setDomainSettings: vi.fn(() => Promise.resolve({ ok: true })),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  send: vi.fn(() => Promise.resolve({ ok: true, id: "s1" })),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  putDraftAttachments: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { listThreads, getCounts, getMe, getIdentities, putDraft } from "../lib/api";

const THREADS: ThreadsResponse = { threads: [], unread: 0, user: "hello@example.com" };
const SIG = "Alex\nExample Co";

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue(THREADS);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 0, starred: 0, sent: 0, all: 0, trash: 0, inboxUnread: 0 });
  vi.mocked(getMe).mockResolvedValue({ email: "hello@example.com" } as Me);
  vi.mocked(getIdentities).mockResolvedValue({
    identities: [
      { domain: "example.com", sendingDomain: "send.example.com", displayName: "Example", signature: SIG },
    ],
    defaultLocal: "hello",
    defaultDomain: "example.com",
  });
});

describe("signature seeding in compose", () => {
  it("seeds the identity signature into a new message", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");

    // The identities query is gated on the dialog opening, so this only passes
    // if seeding waits for the data instead of reading it during [open].
    await waitFor(() => {
      expect(screen.getByLabelText("Message")).toHaveValue(`\n\n${SIG}`);
    });
  });

  it("does not save a draft for a compose that only ever held the signature", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(`\n\n${SIG}`));

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    // Otherwise every opened-and-abandoned compose leaves a draft containing
    // nothing but the signature, and toasts "Draft saved".
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(putDraft).not.toHaveBeenCalled();
  });

  it("still saves a draft once the user actually writes something", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(`\n\n${SIG}`));

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: `Hello there\n\n${SIG}` },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    await waitFor(() => expect(putDraft).toHaveBeenCalled());
  });
});

describe("useSetDomainSettings invalidation", () => {
  it("refreshes identities when the signature changes, not just the sender name", async () => {
    // Compose reads the signature from GET /api/identities, NOT from the
    // settings endpoint. Without this invalidation the user saves a signature
    // and the next compose keeps seeding the old one until a reload - and
    // useIdentities has a 5 minute staleTime, so "until a reload" is literal.
    const { useSetDomainSettings } = await import("../lib/queries");
    const { renderHook } = await import("@testing-library/react");

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useSetDomainSettings(), { wrapper });
    result.current.mutate({ zoneId: "z1", patch: { signature: "x" } });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ["identities"] });
    });
  });
});

describe("recipient suggestions escape their clipping ancestors", () => {
  it("portals the listbox to the body and restores pointer events", async () => {
    // The list is absolutely positioned inside a form that is overflow-y-auto
    // inside an overflow-hidden dialog, so it was cut off when it did not fit:
    // 21px lost at 390x320, 81px at 390x260.
    //
    // The host must be document.body. `position: fixed` resolves against the
    // nearest ancestor with a transform, NOT the viewport, and the dialog is
    // centred with `translate: -50% -50%` - hosting inside it put every
    // coordinate in the dialog's frame (353px of error at 1280x800). That is
    // invisible below `sm`, where the dialog is full-bleed and the error is
    // exactly zero, which is why a mobile-only check passed it.
    //
    // Radix then sets pointer-events:none on the body while a modal is open,
    // so the list has to ask for it back or every option click is swallowed.
    const { getContacts } = await import("../lib/api");
    vi.mocked(getContacts).mockResolvedValue({
      contacts: [{ email: "alice@example.com", name: "Alice" }],
    });

    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "ali" } });

    const list = await screen.findByRole("listbox", { name: "Recipient suggestions" });
    expect(list.parentElement).toBe(document.body);
    expect(list.closest('[data-slot="dialog-content"]')).toBeNull();
    expect(list.style.pointerEvents).toBe("auto");
  });
});
