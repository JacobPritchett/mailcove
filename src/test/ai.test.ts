import { describe, it, expect, vi } from "vitest";
import { buildTranscript, summarizeThread, draftReply, suggestCompletion, SUMMARY_MODEL } from "../ai";

type Msg = Parameters<typeof buildTranscript>[0][number];
function msg(p: Partial<Msg> & { direction: string }): Msg {
  return {
    direction: p.direction,
    msg_from: p.msg_from ?? "Them <them@x.com>",
    date: p.date ?? 0,
    subject: p.subject ?? "",
    body: p.body ?? { text: "", html: "" },
  } as Msg;
}

describe("buildTranscript", () => {
  it("labels outbound as Me and inbound by sender, using plain text", () => {
    const t = buildTranscript([
      msg({ direction: "in", msg_from: "Alice <a@x.com>", body: { text: "Are we still on?", html: "" } }),
      msg({ direction: "out", body: { text: "Yes, 3pm.", html: "" } }),
    ]);
    expect(t).toBe("Alice <a@x.com>: Are we still on?\n\nMe: Yes, 3pm.");
  });

  it("falls back to HTML (tags stripped) when a message has no plain text", () => {
    const t = buildTranscript([msg({ direction: "in", msg_from: "Bob", body: { text: "", html: "<p>Hi <b>there</b></p>" } })]);
    expect(t).toBe("Bob: Hi there");
  });

  it("collapses whitespace and truncates very long transcripts", () => {
    const long = "word ".repeat(5000);
    const t = buildTranscript([msg({ direction: "in", body: { text: long, html: "" } })], 100);
    expect(t.length).toBeLessThanOrEqual(101); // 100 + ellipsis
    expect(t.endsWith("…")).toBe(true);
  });

  it("skips messages with no usable body", () => {
    const t = buildTranscript([
      msg({ direction: "in", msg_from: "A", body: { text: "kept", html: "" } }),
      msg({ direction: "in", msg_from: "B", body: { text: "   ", html: "" } }),
    ]);
    expect(t).toBe("A: kept");
  });
});

describe("summarizeThread", () => {
  function makeEnv(response: string | undefined) {
    const run = vi.fn(
      async (_model: string, _input: { messages: { role: string; content: string }[] }) => ({ response }),
    );
    return { env: { AI: { run } } as any, run };
  }

  it("calls Workers AI with the summary model + system/user messages and returns the response", async () => {
    const { env, run } = makeEnv("• They confirmed 3pm.\nNext: show up.");
    const out = await summarizeThread(env, [
      msg({ direction: "in", msg_from: "Alice", subject: "Meeting", body: { text: "3pm?", html: "" } }),
      msg({ direction: "out", body: { text: "Yes.", html: "" } }),
    ], "Meeting");
    expect(out).toBe("• They confirmed 3pm.\nNext: show up.");
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input] = run.mock.calls[0];
    expect(model).toBe(SUMMARY_MODEL);
    expect(Array.isArray(input.messages)).toBe(true);
    expect(input.messages[0].role).toBe("system");
    expect(input.messages[1].role).toBe("user");
    expect(input.messages[1].content).toContain("Meeting");
    expect(input.messages[1].content).toContain("Alice: 3pm?");
  });

  it("returns a friendly placeholder when there's nothing to summarize (no AI call)", async () => {
    const { env, run } = makeEnv("ignored");
    const out = await summarizeThread(env, [msg({ direction: "in", body: { text: "", html: "" } })], "Empty");
    expect(out).toMatch(/nothing to summarize/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back when the model returns an empty response", async () => {
    const { env } = makeEnv(undefined);
    const out = await summarizeThread(env, [msg({ direction: "in", body: { text: "hi", html: "" } })], "S");
    expect(out).toMatch(/couldn't|no summary/i);
  });
});

describe("draftReply", () => {
  function makeEnv(response: string | undefined) {
    const run = vi.fn(
      async (_model: string, _input: { messages: { role: string; content: string }[] }) => ({ response }),
    );
    return { env: { AI: { run } } as any, run };
  }

  it("drafts a reply from the conversation and returns just the body", async () => {
    const { env, run } = makeEnv("Sounds good — 3pm works for me.");
    const out = await draftReply(env, [
      msg({ direction: "in", msg_from: "Alice", subject: "Meeting", body: { text: "Can we meet at 3pm?", html: "" } }),
    ], "Meeting");
    expect(out).toBe("Sounds good — 3pm works for me.");
    const [model, input] = run.mock.calls[0];
    expect(model).toBe(SUMMARY_MODEL);
    expect(input.messages[0].role).toBe("system");
    expect(input.messages[0].content).toMatch(/reply/i);
    expect(input.messages[1].content).toContain("Alice: Can we meet at 3pm?");
  });

  it("throws when there is no conversation content to reply to", async () => {
    const { env, run } = makeEnv("ignored");
    await expect(
      draftReply(env, [msg({ direction: "in", body: { text: "", html: "" } })], "Empty"),
    ).rejects.toThrow(/nothing to reply|no conversation/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("throws when the model returns an empty draft", async () => {
    const { env } = makeEnv("   ");
    await expect(
      draftReply(env, [msg({ direction: "in", body: { text: "hi", html: "" } })], "S"),
    ).rejects.toThrow(/empty draft/i);
  });
});

describe("suggestCompletion", () => {
  function makeEnv(response: string | undefined) {
    const run = vi.fn(
      async (_model: string, _input: { messages: { role: string; content: string }[] }) => ({ response }),
    );
    return { env: { AI: { run } } as any, run };
  }

  it("returns a short continuation, adding a leading space when the draft needs one", async () => {
    const { env } = makeEnv("you next week");
    const out = await suggestCompletion(env, "Catch up", "Hi Sam, I wanted to see if we could meet");
    expect(out).toBe(" you next week");
  });

  it("does not double-space when the draft already ends with whitespace", async () => {
    const { env } = makeEnv("see you there");
    const out = await suggestCompletion(env, "Re: party", "Sounds great, ");
    expect(out).toBe("see you there");
  });

  it("keeps a single separator when the model reply itself has a leading space (no gluing)", async () => {
    const { env } = makeEnv(" you next week");
    const out = await suggestCompletion(env, "Catch up", "I wanted to see if we could meet");
    expect(out).toBe(" you next week");
  });

  it("does not insert a space before attaching punctuation", async () => {
    const { env } = makeEnv(", and let me know what works");
    const out = await suggestCompletion(env, "Catch up", "Let's meet Tuesday");
    expect(out).toBe(", and let me know what works");
  });

  it("returns '' without calling the model for a too-short draft", async () => {
    const { env, run } = makeEnv("ignored");
    expect(await suggestCompletion(env, "s", "ok")).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns '' when the model declines (empty response)", async () => {
    const { env } = makeEnv("");
    expect(await suggestCompletion(env, "s", "Hello there friend")).toBe("");
  });

  it("strips a wrapping quote and caps length", async () => {
    const { env } = makeEnv('"' + "word ".repeat(60) + '"');
    const out = await suggestCompletion(env, "s", "Here is a long one:");
    expect(out.length).toBeLessThanOrEqual(121); // 120 + possible leading space
    expect(out.includes('"')).toBe(false);
  });
});
