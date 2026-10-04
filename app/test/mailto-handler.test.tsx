// mailto: links end up in the app's own composer, filled in and never sent:
// from the browser's protocol handler URL, from a link in a message frame,
// and from a link in the app's own markup.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Vite's ?raw gives the file's text (the app tsconfig has no node types for fs).
import MANIFEST from "../../public/manifest.webmanifest?raw";
import App from "../App";
import SettingsDialog from "../components/SettingsDialog";
import { interceptLinks } from "../lib/emailFrame";
import { HANDLER_PATH, openMailto, setMailtoComposer } from "../lib/mailtoHandler";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(() => Promise.resolve({ email: "me@example.com" })),
  getIdentities: vi.fn(() =>
    Promise.resolve({
      identities: [{ domain: "example.com", sendingDomain: "send.example.com", displayName: "Me", signature: "Alex" }],
      defaultLocal: "hello",
      defaultDomain: "example.com",
    }),
  ),
  send: vi.fn(() => Promise.resolve({ ok: true, id: "sent" })),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  putDraftAttachments: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

import { toast } from "sonner";
import { listThreads, getCounts, getThread, send, putDraft } from "../lib/api";

const ROW = {
  thread_id: "t1", id: "m1", msg_from: "Alice <alice@example.com>", msg_to: "me@example.com",
  subject: "Plain text mail", snippet: "s", date: Date.now(), count: 1, anyUnread: 0, hasAttachments: 0, starred: 0, category: null,
};
const THREAD = {
  thread_id: "t1",
  messages: [{
    id: "m1", thread_id: "t1", direction: "in", folder: "inbox", msg_from: "Alice <alice@example.com>",
    msg_to: "me@example.com", subject: "Plain text mail", snippet: "s", date: Date.now(), unread: 0,
    has_attachments: 0, msg_cc: null, message_id: "<mid>", in_reply_to: null,
    body: { text: "Write to mailto:support@example.com?subject=Help for details", html: "", attachments: [] },
  }],
};

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><App /></QueryClientProvider>);
}
const settle = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue({ threads: [ROW], unread: 0, user: "me" } as never);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, inboxUnread: 0 } as never);
  vi.mocked(getThread).mockResolvedValue(THREAD as never);
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("the protocol handler URL", () => {
  it("opens the composer filled in from the link, strips it from the address bar, and sends nothing", async () => {
    const link = "mailto:ada@example.com,bob@example.com?cc=carol@example.com&bcc=dan@example.com&subject=Lunch%20on%20Friday&body=Noon%3F%0AAt%20the%20usual%20place.";
    window.history.replaceState(null, "", `/?compose=${encodeURIComponent(link)}`);
    renderApp();
    const dialog = await screen.findByRole("dialog");
    for (const address of ["ada@example.com", "bob@example.com", "carol@example.com", "dan@example.com"]) {
      expect(within(dialog).getByText(address)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Subject")).toHaveValue("Lunch on Friday");
    expect(await screen.findByLabelText("Message")).toHaveValue("Noon?\nAt the usual place.");
    expect(window.location.search).toBe("");
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a thread parameter that came with it out of the way of the next reload too", async () => {
    window.history.replaceState(null, "", `/?compose=${encodeURIComponent("mailto:ada@example.com")}&other=1`);
    renderApp();
    await screen.findByRole("dialog");
    expect(window.location.search).toBe("?other=1");
  });

  it("opens nothing for a compose parameter that is not a mailto: link, and still strips it", async () => {
    window.history.replaceState(null, "", `/?compose=${encodeURIComponent("javascript:alert(1)")}`);
    renderApp();
    await screen.findByText("Plain text mail");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("takes only what a link may set: no attachment, no sender, no headers smuggled through a newline", async () => {
    const link =
      "mailto:ada@example.com?attach=/etc/passwd&from=ceo@example.com&subject=Hi%0D%0ABcc:%20evil@example.com&body=ok";
    window.history.replaceState(null, "", `/?compose=${encodeURIComponent(link)}`);
    renderApp();
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByLabelText("Subject")).toHaveValue("Hi Bcc: evil@example.com");
    expect(within(dialog).queryByText("evil@example.com")).toBeNull();
    expect(screen.getByLabelText("From local part")).toHaveValue("hello");
    expect(within(dialog).queryByText(/passwd/)).toBeNull();
  });

  it("seeds the signature into a link with no body, and such a message closed untouched leaves no draft", async () => {
    window.history.replaceState(null, "", `/?compose=${encodeURIComponent("mailto:ada@example.com")}`);
    renderApp();
    await screen.findByRole("dialog");
    await waitFor(async () => expect(await screen.findByLabelText("Message")).toHaveValue("\n\nAlex"));
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await settle(80);
    expect(putDraft).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith("Draft saved");
  });

  it("a link with copies, a subject and a body, closed untouched, leaves no draft either", async () => {
    const link = "mailto:ada@example.com?cc=carol@example.com&bcc=dan@example.com&subject=Hi&body=Hello";
    window.history.replaceState(null, "", `/?compose=${encodeURIComponent(link)}`);
    renderApp();
    await screen.findByRole("dialog");
    await settle(80);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await settle(80);
    expect(putDraft).not.toHaveBeenCalled();
  });

  it("but one the user added to is kept as a draft", async () => {
    window.history.replaceState(null, "", `/?compose=${encodeURIComponent("mailto:ada@example.com?subject=Hi")}`);
    renderApp();
    await screen.findByRole("dialog");
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Something I wrote" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(putDraft).toHaveBeenCalled());
  });

  it("leaves a body the link brought alone", async () => {
    window.history.replaceState(null, "", `/?compose=${encodeURIComponent("mailto:ada@example.com?body=Hello")}`);
    renderApp();
    await screen.findByRole("dialog");
    await settle(80);
    expect(await screen.findByLabelText("Message")).toHaveValue("Hello");
  });
});

describe("a mailto: link inside received mail", () => {
  it("in the app's own markup (chat mode, a plain-text body) opens the composer instead of leaving the app", async () => {
    renderApp();
    await screen.findByText("Plain text mail");
    // Wherever React rendered it: the handler is on the document.
    const link = document.createElement("a");
    link.href = "mailto:support@example.com?subject=Help";
    link.textContent = "write to support";
    document.body.appendChild(link);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    link.remove();
    expect(click.defaultPrevented).toBe(true);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("support@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("Help");
  });

  it("leaves other links alone", async () => {
    renderApp();
    await screen.findByText("Plain text mail");
    const link = document.createElement("a");
    link.href = "https://example.com/";
    document.body.appendChild(link);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    // jsdom would try to navigate: stop that after the app's handler has had its say.
    link.addEventListener("click", (e) => {
      expect(e.defaultPrevented).toBe(false);
      e.preventDefault();
    });
    link.dispatchEvent(click);
    link.remove();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("in a message frame is handed to the composer, not to window.open", () => {
    const composed = vi.fn();
    const withdraw = setMailtoComposer(composed);
    const doc = document.implementation.createHTMLDocument("mail");
    doc.body.innerHTML = `<a id="m" href="mailto:ada@example.com?subject=Hi">write</a><a id="w" href="https://example.com/">web</a>`;
    const open = vi.fn();
    const stop = interceptLinks(doc, { open, location: { href: "https://inbox.example/" } });
    doc.getElementById("m")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(composed).toHaveBeenCalledWith({ to: "ada@example.com", cc: "", bcc: "", subject: "Hi", body: "" });
    expect(open).not.toHaveBeenCalled();
    // Web links are unchanged.
    doc.getElementById("w")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
    stop();
    withdraw();
  });

  it("falls back to the old behaviour when no composer is mounted", () => {
    const doc = document.implementation.createHTMLDocument("mail");
    doc.body.innerHTML = `<a id="m" href="mailto:ada@example.com">write</a>`;
    const open = vi.fn();
    const stop = interceptLinks(doc, { open, location: { href: "https://inbox.example/" } });
    doc.getElementById("m")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith("mailto:ada@example.com", "_blank", "noopener,noreferrer");
    stop();
    expect(openMailto("mailto:ada@example.com")).toBe(false);
  });
});

describe("registering as the handler", () => {
  const original = navigator.registerProtocolHandler;
  afterEach(() => {
    Object.defineProperty(navigator, "registerProtocolHandler", { configurable: true, value: original });
  });

  it("is only ever asked for from the Settings button, with the URL the manifest names", () => {
    const register = vi.fn();
    Object.defineProperty(navigator, "registerProtocolHandler", { configurable: true, value: register });
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(register).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open email links here" }));
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("mailto", `${window.location.origin}${HANDLER_PATH}`);
    expect(screen.getByRole("button", { name: "Ask again" })).toBeInTheDocument();
  });

  it("is not requested by loading the app", async () => {
    const register = vi.fn();
    Object.defineProperty(navigator, "registerProtocolHandler", { configurable: true, value: register });
    renderApp();
    await screen.findByText("Plain text mail");
    expect(register).not.toHaveBeenCalled();
  });

  it("says so when the browser refuses", () => {
    Object.defineProperty(navigator, "registerProtocolHandler", {
      configurable: true,
      value: () => {
        throw new DOMException("refused", "SecurityError");
      },
    });
    render(<SettingsDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open email links here" }));
    expect(toast.error).toHaveBeenCalled();
  });

  it("hides the control in a browser that cannot register handlers", () => {
    Object.defineProperty(navigator, "registerProtocolHandler", { configurable: true, value: undefined });
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Open email links here" })).toBeNull();
  });

  it("the web manifest declares the same handler URL", () => {
    const manifest = JSON.parse(MANIFEST) as {
      protocol_handlers?: { protocol: string; url: string }[];
    };
    expect(manifest.protocol_handlers).toEqual([{ protocol: "mailto", url: HANDLER_PATH }]);
  });
});
