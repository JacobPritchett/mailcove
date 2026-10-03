// Forwarding: which files travel, what the dialog says about the ones that
// do not, and that closing the dialog never loses the ones that do.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ComposeDialog, { type ComposeInitial } from "../components/ComposeDialog";
import { planForward, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from "../lib/attachments";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  send: vi.fn(() => Promise.resolve({ ok: true, id: "sent-1" })),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  putDraftAttachments: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getAttachmentBase64: vi.fn(),
  getIdentities: vi.fn(() =>
    Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { send, putDraft, putDraftAttachments, getAttachmentBase64 } from "../lib/api";

const part = (name: string, size = 10) => ({ partId: `p-${name}`, name, type: "application/pdf", size });
const forward = (parts: ReturnType<typeof part>[], notStored?: string[]): ComposeInitial => ({
  subject: "Fwd: Lease",
  text: "\n\n---------- Forwarded message ----------\nFrom: Maya\n\nLease attached.",
  generated: true,
  forward: { messageId: "m1", parts, notStored },
});

/** The dialog with a way to close it, as App does (it stays mounted). */
function renderDialog(initial: ComposeInitial) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <QueryClientProvider client={qc}>
        <button type="button" onClick={() => setOpen(false)}>close it</button>
        <ComposeDialog open={open} onOpenChange={setOpen} initial={initial} />
      </QueryClientProvider>
    );
  }
  return render(<Harness />);
}
const close = () => fireEvent.click(screen.getByRole("button", { name: "close it", hidden: true }));
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAttachmentBase64).mockImplementation((_id, name) => Promise.resolve(`bytes-of-${name}`));
});

describe("planForward", () => {
  const MB = 1024 * 1024;
  it("keeps what fits, in order", () => {
    expect(planForward([part("a"), part("b")]).fits.map((p) => p.name)).toEqual(["a", "b"]);
  });
  it("calls a file over the per-file cap, or one that would take the total over, too large", () => {
    const plan = planForward([part("huge", MAX_ATTACHMENT_BYTES + 1), part("a", 4 * MB), part("b", 4 * MB), part("c", 4 * MB), part("small", 1)]);
    expect(MAX_TOTAL_ATTACHMENT_BYTES).toBe(10 * MB);
    expect(plan).toEqual({ fits: [part("a", 4 * MB), part("b", 4 * MB), part("small", 1)], tooLarge: ["huge", "c"], tooMany: [] });
  });
  it("calls the eleventh and later files too many, not too large", () => {
    const plan = planForward(Array.from({ length: 12 }, (_, i) => part(`f${i}`)));
    expect(plan.fits).toHaveLength(10);
    expect(plan.tooLarge).toEqual([]);
    expect(plan.tooMany).toEqual(["f10", "f11"]);
  });
});

describe("what a forward says it could not carry", () => {
  it("gives each reason in its own words", async () => {
    renderDialog(
      forward(
        [part("huge.mov", MAX_ATTACHMENT_BYTES + 1), ...Array.from({ length: 11 }, (_, i) => part(`f${i}.pdf`))],
        ["gone.zip"],
      ),
    );
    expect(await screen.findByText("Not stored with the original, so not forwarded: gone.zip")).toBeInTheDocument();
    expect(screen.getByText(/^Too large to send \(5\.0 MB a file, 10\.0 MB in all\), so not forwarded: huge\.mov$/)).toBeInTheDocument();
    expect(screen.getByText("Over the limit of 10 files, so not forwarded: f10.pdf")).toBeInTheDocument();
    // The ten that fit were fetched; the others were not.
    await waitFor(() => expect(getAttachmentBase64).toHaveBeenCalledTimes(10));
    expect(vi.mocked(getAttachmentBase64).mock.calls.map((c) => c[1])).not.toContain("huge.mov");
  });

  it("says so even when nothing at all can be carried", async () => {
    renderDialog(forward([], ["gone.zip"]));
    expect(await screen.findByText("Not stored with the original, so not forwarded: gone.zip")).toBeInTheDocument();
    expect(getAttachmentBase64).not.toHaveBeenCalled();
    expect(screen.queryByText(/Loading attachments/)).toBeNull();
  });
});

describe("a file that fails to download", () => {
  it("does not take the others with it; Retry asks only for that one", async () => {
    vi.mocked(getAttachmentBase64).mockImplementation((_id, name) =>
      name === "b.pdf" ? Promise.reject(new Error("502")) : Promise.resolve(`bytes-of-${name}`),
    );
    renderDialog(forward([part("a.pdf"), part("b.pdf"), part("c.pdf")]));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load from the forwarded message: b.pdf");
    expect(screen.getByText("a.pdf")).toBeInTheDocument();
    expect(screen.getByText("c.pdf")).toBeInTheDocument();

    vi.mocked(getAttachmentBase64).mockClear();
    vi.mocked(getAttachmentBase64).mockImplementation((_id, name) => Promise.resolve(`bytes-of-${name}`));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("b.pdf")).toBeInTheDocument());
    expect(vi.mocked(getAttachmentBase64).mock.calls.map((c) => c[1])).toEqual(["b.pdf"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Continue without them keeps the ones that did download, and they are sent", async () => {
    vi.mocked(getAttachmentBase64).mockImplementation((_id, name) =>
      name === "b.pdf" ? Promise.reject(new Error("502")) : Promise.resolve(`bytes-of-${name}`),
    );
    renderDialog(forward([part("a.pdf"), part("b.pdf")]));
    fireEvent.click(await screen.findByRole("button", { name: "Continue without them" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("a.pdf")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(send).mock.calls[0][0].attachments).toEqual([
      { filename: "a.pdf", type: "application/pdf", data: "bytes-of-a.pdf" },
    ]);
  });
});

describe("closing a forward", () => {
  it("untouched, leaves no draft behind (not on close, not from the autosave)", async () => {
    renderDialog(forward([part("a.pdf")]));
    await screen.findByText("a.pdf");
    await settle(1700); // past the autosave debounce
    close();
    await settle();
    expect(putDraft).not.toHaveBeenCalled();
    expect(putDraftAttachments).not.toHaveBeenCalled();
  });

  it("with a recipient added, saves the draft with its files", async () => {
    renderDialog(forward([part("a.pdf")]));
    await screen.findByText("a.pdf");
    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@x.com" } });
    close();
    await waitFor(() => expect(putDraftAttachments).toHaveBeenCalled());
    expect(vi.mocked(putDraftAttachments).mock.calls[0][1]).toEqual([
      { name: "a.pdf", type: "application/pdf", data: "bytes-of-a.pdf" },
    ]);
  });

  it("while its files are still loading, saves the draft at once and its files when they arrive", async () => {
    let release!: (data: string) => void;
    vi.mocked(getAttachmentBase64).mockImplementation(() => new Promise((r) => (release = r)));
    renderDialog(forward([part("a.pdf")]));
    expect(await screen.findByText(/Loading attachments/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@x.com" } });
    close();
    // The text is safe immediately...
    await waitFor(() => expect(putDraft).toHaveBeenCalled());
    await settle();
    expect(putDraftAttachments).not.toHaveBeenCalled();
    // ...and the files follow, to the same draft.
    await act(async () => release("late-bytes"));
    await waitFor(() => expect(putDraftAttachments).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putDraftAttachments).mock.calls[0]).toEqual([
      vi.mocked(putDraft).mock.calls[0][0],
      [{ name: "a.pdf", type: "application/pdf", data: "late-bytes" }],
    ]);
  });

  it("with one file failed, still saves the ones that arrived", async () => {
    vi.mocked(getAttachmentBase64).mockImplementation((_id, name) =>
      name === "b.pdf" ? Promise.reject(new Error("502")) : Promise.resolve(`bytes-of-${name}`),
    );
    renderDialog(forward([part("a.pdf"), part("b.pdf")]));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@x.com" } });
    close();
    await waitFor(() => expect(putDraftAttachments).toHaveBeenCalled());
    expect(vi.mocked(putDraftAttachments).mock.calls[0][1].map((f) => f.name)).toEqual(["a.pdf"]);
  });
});
