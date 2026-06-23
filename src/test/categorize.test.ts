import { describe, it, expect, vi } from "vitest";
import { parseCategory, classifyMessage, CATEGORIZE_MODEL } from "../categorize";

describe("parseCategory", () => {
  it("accepts a single label with surrounding whitespace / trailing period", () => {
    expect(parseCategory("primary")).toBe("primary");
    expect(parseCategory("Promotions")).toBe("promotions");
    expect(parseCategory("Updates.")).toBe("updates");
    expect(parseCategory("  social  ")).toBe("social");
  });
  it("does NOT substring-scan: chatty/ambiguous output yields null, not a wrong label", () => {
    expect(parseCategory("not promotions, updates")).toBeNull();
    expect(parseCategory("Category: Updates")).toBeNull();
    expect(parseCategory("this looks like social mail")).toBeNull();
  });
  it("returns null for unknown / non-string input", () => {
    expect(parseCategory("spam")).toBeNull();
    expect(parseCategory("")).toBeNull();
    expect(parseCategory(undefined)).toBeNull();
    expect(parseCategory(42)).toBeNull();
  });
});

describe("classifyMessage", () => {
  function makeEnv(response: string | undefined) {
    const run = vi.fn(
      async (_model: string, _input: { messages: { role: string; content: string }[] }) => ({ response }),
    );
    return { env: { AI: { run } } as any, run };
  }

  it("calls Workers AI with the model + from/subject/preview and returns the parsed category", async () => {
    const { env, run } = makeEnv("promotions");
    const out = await classifyMessage(env, { from: "Deals <a@shop.com>", subject: "50% off!", snippet: "Sale ends today" });
    expect(out).toBe("promotions");
    const [model, input] = run.mock.calls[0];
    expect(model).toBe(CATEGORIZE_MODEL);
    expect(input.messages[0].role).toBe("system");
    expect(input.messages[1].content).toContain("50% off!");
    expect(input.messages[1].content).toContain("Deals <a@shop.com>");
  });

  it("defaults to primary when the model returns garbage or nothing", async () => {
    expect(await classifyMessage(makeEnv("???").env, { from: "x", subject: "y", snippet: "z" })).toBe("primary");
    expect(await classifyMessage(makeEnv(undefined).env, { from: "x", subject: "y", snippet: "z" })).toBe("primary");
  });
});
