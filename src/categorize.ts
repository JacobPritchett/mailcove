// AI auto-labels — classify an inbound message into a coarse category using
// Workers AI. Best-effort: callers default to "primary" (and never block mail
// delivery) when classification fails.

/** The fixed category set. Order is the display order in the UI filter bar. */
export const CATEGORIES = ["primary", "promotions", "updates", "social"] as const;
export type Category = (typeof CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(CATEGORIES);

/**
 * Narrow an arbitrary model response to a Category, or null if it isn't one.
 * The system prompt asks for ONLY the single word, so we accept the whole
 * response as exactly one label (allowing surrounding whitespace and a trailing
 * period). We deliberately do NOT substring-scan — "not promotions, updates"
 * must NOT be read as "promotions". Anything else → null (caller defaults).
 */
export function parseCategory(raw: unknown): Category | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase().replace(/[.!]+$/, "").trim();
  return CATEGORY_SET.has(normalized) ? (normalized as Category) : null;
}

interface AiEnv {
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<{ response?: string }> };
}

/** Same affordable instruct model used elsewhere (see src/ai.ts). */
export const CATEGORIZE_MODEL = "@cf/meta/llama-3.1-8b-instruct";

const SYSTEM =
  "You are an email classifier. Classify the email into EXACTLY ONE category and reply with ONLY that single lowercase word, nothing else:\n" +
  "- primary: personal or work mail from a real person, or anything that expects a reply\n" +
  "- promotions: marketing, sales, deals, newsletters, offers\n" +
  "- updates: automated notifications, receipts, confirmations, statements, alerts, system mail\n" +
  "- social: notifications from social networks or community platforms\n" +
  "When unsure, choose primary.";

export interface ClassifyInput { from: string; subject: string; snippet: string; }

/**
 * Classify an inbound message. Returns a Category, defaulting to "primary" on an
 * empty/unrecognized model response. THROWS only if the AI call itself rejects —
 * callers in the mail path must catch and default so delivery never breaks.
 */
export async function classifyMessage(env: AiEnv, input: ClassifyInput): Promise<Category> {
  const user =
    `From: ${input.from || "(unknown)"}\n` +
    `Subject: ${input.subject || "(no subject)"}\n` +
    `Preview: ${(input.snippet || "").slice(0, 300)}`;
  const res = await env.AI.run(CATEGORIZE_MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
  });
  return parseCategory(res.response) ?? "primary";
}
