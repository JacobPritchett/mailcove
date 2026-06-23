// Workers AI helpers — conversation summary (and a reusable transcript builder
// that future AI features like reply-drafting can share).
//
// Model choice: an affordable, capable instruct model on Workers AI. (MiniMax
// is NOT a Workers AI model — it would need an external API + key; swap
// SUMMARY_MODEL or point at an external endpoint if that's ever wanted.)

/** Workers AI text-generation model used for summaries. */
export const SUMMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct";

interface AiEnv {
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<{ response?: string }> };
}

/** Minimal shape buildTranscript needs from a thread message. */
interface TranscriptMessage {
  direction: string;
  msg_from: string;
  date: number;
  subject?: string;
  body: { text?: string; html?: string };
}

function plainBody(body: { text?: string; html?: string }): string {
  const raw = body.text && body.text.trim() ? body.text : (body.html || "").replace(/<[^>]+>/g, " ");
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Render a conversation as a compact `Speaker: text` transcript for the model.
 * Outbound messages are labelled "Me"; inbound by sender. Empty messages are
 * skipped. The whole thing is truncated to maxChars so a long thread can't blow
 * the model's context (or our token budget).
 */
export function buildTranscript(messages: TranscriptMessage[], maxChars = 6000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = plainBody(m.body);
    if (!text) continue;
    const who = m.direction === "out" ? "Me" : (m.msg_from || "Them");
    lines.push(`${who}: ${text}`);
  }
  let joined = lines.join("\n\n");
  if (joined.length > maxChars) joined = joined.slice(0, maxChars) + "…";
  return joined;
}

const SUMMARY_SYSTEM =
  "You are a concise email assistant. Summarize the email conversation in 2–4 short bullet points capturing the key facts and any decisions, then a final line beginning \"Next:\" with the single most useful next action for the inbox owner. Be factual and brief; never invent details that aren't in the conversation.";

/**
 * Summarize a thread's messages via Workers AI. Returns plain text (bullets +
 * a "Next:" line). Throws if the AI call itself fails — the caller maps that to
 * a 502 so the UI can show a friendly error.
 */
export async function summarizeThread(
  env: AiEnv,
  messages: TranscriptMessage[],
  subject: string,
): Promise<string> {
  const transcript = buildTranscript(messages);
  if (!transcript.trim()) return "Nothing to summarize — this conversation has no text.";
  const res = await env.AI.run(SUMMARY_MODEL, {
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: `Subject: ${subject || "(no subject)"}\n\n${transcript}` },
    ],
  });
  return (res.response || "").trim() || "The model couldn't produce a summary — try again.";
}

const DRAFT_SYSTEM =
  "You are drafting a reply on behalf of the inbox owner (shown as \"Me\" in the transcript). Write a concise, natural reply to the MOST RECENT message from the other person. Output ONLY the reply body text — no subject line, no quoted text, no \"[Your Name]\" or signature placeholders. Match the conversation's tone; be warm and direct, and if a question was asked, answer or acknowledge it. Keep it brief.";

/**
 * Draft a reply to a conversation on the inbox owner's behalf via Workers AI.
 * Returns the reply body text (no subject/quote). Throws when there's nothing to
 * reply to or the model returns nothing — the caller maps that to a 502 so the
 * UI shows a friendly error.
 */
export async function draftReply(
  env: AiEnv,
  messages: TranscriptMessage[],
  subject: string,
): Promise<string> {
  const transcript = buildTranscript(messages);
  if (!transcript.trim()) throw new Error("no conversation content to reply to");
  const res = await env.AI.run(SUMMARY_MODEL, {
    messages: [
      { role: "system", content: DRAFT_SYSTEM },
      { role: "user", content: `Subject: ${subject || "(no subject)"}\n\nConversation so far:\n${transcript}\n\nDraft my reply:` },
    ],
  });
  const draft = (res.response || "").trim();
  if (!draft) throw new Error("model returned an empty draft");
  return draft;
}

const SUGGEST_SYSTEM =
  "You are an email autocomplete, like Gmail Smart Compose. Continue the user's draft from exactly where it stops with a SHORT, natural continuation — a few words up to one sentence. Output ONLY the text that comes next (no quotes, no preamble, no repetition of what's already written). Include a leading space if the draft doesn't end with whitespace and a space is needed. If there's no confident, useful continuation, output nothing.";

/** Hard cap on a suggestion's length so a runaway model can't dump a paragraph. */
const MAX_SUGGESTION_CHARS = 120;

/**
 * Suggest a short continuation of an in-progress email draft. Pure-ish: returns
 * "" when there's too little to go on or the model declines. Never throws for an
 * empty result (autocomplete is best-effort) — only a transport error rejects.
 */
export async function suggestCompletion(env: AiEnv, subject: string, text: string): Promise<string> {
  const trimmed = (text || "").trim();
  if (trimmed.length < 3) return "";
  const res = await env.AI.run(SUMMARY_MODEL, {
    messages: [
      { role: "system", content: SUGGEST_SYSTEM },
      { role: "user", content: `Subject: ${subject || "(no subject)"}\n\nDraft so far:\n${text}` },
    ],
  });
  let s = (res.response || "").trim();
  if (!s) return "";
  // Models sometimes echo a wrapping quote — strip a single pair.
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  // Normalize FIRST (collapse/trim), THEN decide spacing from the normalized
  // text — otherwise a model reply like " see you" loses its space and glues.
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.slice(0, MAX_SUGGESTION_CHARS).trim();
  if (!s) return "";
  // Prepend a space only if the draft ends mid-word AND the continuation doesn't
  // start with punctuation that attaches to the previous token.
  const attaches = /^[.,!?;:)\]}%'’"]/.test(s);
  const needsSpace = /\S$/.test(text) && !attaches;
  return needsSpace ? ` ${s}` : s;
}
