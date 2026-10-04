// A rejected request and a lost response are different recovery situations.
export function sendFeedback(error: unknown): string {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  const reason = error instanceof Error ? error.message : "";
  if (status >= 400 && status < 500 && status !== 408) {
    return `Message not sent. ${reason || `The server rejected the request (${status}).`} Your message is still here. Correct the problem, then try Send again.`;
  }
  return "Couldn't confirm whether this message was sent. Check Sent before trying again to avoid a duplicate. Your message is still here.";
}
