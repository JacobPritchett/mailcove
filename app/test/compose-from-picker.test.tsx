import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ComposeDialog, { type ComposeInitial } from "../components/ComposeDialog";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  send: vi.fn(),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  draftReply: vi.fn(),
  getIdentities: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { send, getIdentities } from "../lib/api";

const TWO_IDENTITIES = {
  identities: [
    { domain: "example.net", sendingDomain: "send.example.net", displayName: "Mailcove" },
    { domain: "example.com", sendingDomain: "example.com", displayName: "Example" },
  ],
  defaultLocal: "hello",
  defaultDomain: "example.net",
};

function renderDialog(initial?: ComposeInitial) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ComposeDialog open onOpenChange={() => {}} initial={initial} />
    </QueryClientProvider>,
  );
}

async function fillAndSend() {
  fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@x.com" } });
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "hi" } });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getIdentities).mockResolvedValue(TWO_IDENTITIES);
  vi.mocked(send).mockResolvedValue({ ok: true, id: "sent-1" });
});

describe("Compose From identity picker", () => {
  it("renders a domain select when more than one identity can send", async () => {
    renderDialog();
    const select = await screen.findByLabelText("From domain");
    expect(select).toHaveValue("example.net");
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(["example.net", "example.com"]);
  });

  it("sends from the picked identity (local@domain)", async () => {
    renderDialog();
    const select = await screen.findByLabelText("From domain");
    fireEvent.change(select, { target: { value: "example.com" } });
    await fillAndSend();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "hello@example.com" }));
  });

  it("defaults the picker to the reply context's domain", async () => {
    renderDialog({ fromDomain: "example.com", threadId: "t1" });
    const select = await screen.findByLabelText("From domain");
    expect(select).toHaveValue("example.com");
    await fillAndSend();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "hello@example.com" }));
  });

  it("ignores a reply-context domain that can't send", async () => {
    renderDialog({ fromDomain: "cant-send.net" });
    const select = await screen.findByLabelText("From domain");
    expect(select).toHaveValue("example.net");
  });

  it("falls back to a static identity (no select) when identities can't load", async () => {
    vi.mocked(getIdentities).mockRejectedValue(new Error("boom"));
    renderDialog();
    expect(screen.queryByLabelText("From domain")).not.toBeInTheDocument();
    expect(await screen.findByText("@example.com")).toBeInTheDocument();
    await fillAndSend();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "hello@example.com" }));
  });

  it("preserves the reply's intended domain when identities can't load (server validates)", async () => {
    vi.mocked(getIdentities).mockRejectedValue(new Error("boom"));
    renderDialog({ fromDomain: "example.com", threadId: "t1" });
    expect(await screen.findByText("@example.com")).toBeInTheDocument();
    await fillAndSend();
    // The intended identity ships; if it can't send, the server 400s loudly
    // instead of the mail silently going out under a different domain.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "hello@example.com" }));
  });
});

describe("Compose From name (sending profile)", () => {
  it("prefills the From name from the identity's profile and tracks the picked domain", async () => {
    renderDialog();
    const name = await screen.findByLabelText("From name");
    await waitFor(() => expect(name).toHaveValue("Mailcove"));
    fireEvent.change(screen.getByLabelText("From domain"), { target: { value: "example.com" } });
    expect(name).toHaveValue("Example");
  });

  it("sends the (edited) From name with the message", async () => {
    renderDialog();
    const name = await screen.findByLabelText("From name");
    await waitFor(() => expect(name).toHaveValue("Mailcove"));
    fireEvent.change(name, { target: { value: "Alex at Mailcove" } });
    // An explicit edit sticks even when the domain changes afterwards.
    fireEvent.change(screen.getByLabelText("From domain"), { target: { value: "example.com" } });
    expect(name).toHaveValue("Alex at Mailcove");
    await fillAndSend();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ from: "hello@example.com", fromName: "Alex at Mailcove" }),
    );
  });

  it("omits fromName when cleared (server falls back to the profile name)", async () => {
    renderDialog();
    const name = await screen.findByLabelText("From name");
    await waitFor(() => expect(name).toHaveValue("Mailcove"));
    fireEvent.change(name, { target: { value: "  " } });
    await fillAndSend();
    expect(vi.mocked(send).mock.calls[0][0]).not.toHaveProperty("fromName");
  });

  it("omits fromName when the prefill is untouched — the server resolves the live profile", async () => {
    renderDialog();
    const name = await screen.findByLabelText("From name");
    await waitFor(() => expect(name).toHaveValue("Mailcove"));
    await fillAndSend();
    // No explicit edit → no override; a stale cached prefill must not freeze
    // an outdated name into the message.
    expect(vi.mocked(send).mock.calls[0][0]).not.toHaveProperty("fromName");
  });
});
