// A timestamp that stays true while you look at it.
//
// The reader renders "9:41 AM" / "Jul 21 (13 days ago)" from a `now` captured
// during render, so a message opened at 23:59 still claimed "11:59 PM" well
// past midnight — and a thread left open overnight kept saying "yesterday" the
// day after. Nothing re-rendered it, because nothing about the message changed.
//
// It ticks in its own component so only this subtree re-renders: the reader's
// message body is a sandboxed iframe, and re-rendering that once a minute would
// be a real cost for a line of text.
import { useEffect, useState } from "react";
import { formatFullDate } from "@/lib/format";

/**
 * A minute is comfortably finer than anything the format distinguishes — the
 * shortest unit it prints is a wall-clock minute, and the thresholds it crosses
 * (today → yesterday → N days) are day boundaries.
 */
const TICK_MS = 60_000;

export interface RelativeTimeProps {
  /** Epoch milliseconds. */
  date: number;
  className?: string;
}

export default function RelativeTime({ date, className }: RelativeTimeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const d = new Date(date);
  return (
    <time
      dateTime={d.toISOString()}
      // The exact instant, for anyone who needs to cite it. The disclosure
      // panel carries it too, since a title is unreachable on a touch device.
      title={d.toLocaleString()}
      className={className}
    >
      {formatFullDate(date, now)}
    </time>
  );
}
