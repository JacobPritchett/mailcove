// Pure view transforms for the message UI. `now` is injected wherever the
// current time matters so callers (and tests) stay deterministic — no Date.now().

/**
 * Format a message timestamp for a list row.
 * Same calendar day as `now` → a local time like "9:41 AM".
 * Otherwise → short month + day like "Jun 3".
 */
export function formatDate(ms: number, now: number): string {
  const d = new Date(ms);
  const ref = new Date(now);
  const sameDay =
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Display label for a sender field.
 * "Name <addr@x>" → "Name"; bare "addr@x" → "addr@x"; "" → "".
 */
export function senderLabel(msgFrom: string): string {
  const s = msgFrom.trim();
  if (!s) return "";
  const m = s.match(/^(.*?)<[^>]*>\s*$/);
  if (m) {
    const name = m[1].trim();
    if (name) return name;
    // "<addr@x>" with no name → fall through to the bare address.
    return addressOf(s);
  }
  return s;
}

/**
 * Extract the email address from "Name <addr>" or return the bare string.
 */
export function addressOf(msgFrom: string): string {
  const s = msgFrom.trim();
  if (!s) return "";
  const m = s.match(/<([^>]*)>\s*$/);
  return m ? m[1].trim() : s;
}
