// A calendar invite, shown above the message it came with: what, when (in the
// reader's own time zone), where, and who is asking. Read on the client from
// the .ics attachment by lib/ics, which returns plain strings only; everything
// here is rendered as text, so nothing in the file can become markup.
//
// It shows the invite. It does not answer it: no RSVP is sent from here.
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Download, MapPin, Repeat, User } from "lucide-react";
import { attachmentUrl, getAttachmentText } from "@/lib/api";
import { formatIcsWhen, ICS_MAX_BYTES, parseIcs } from "@/lib/ics";
import type { Attachment } from "@/lib/types";

/** The message's calendar file, if it has one the client can read. */
export function inviteAttachment(attachments: Attachment[]): Attachment | null {
  return (
    attachments.find(
      (a) =>
        a.stored !== false &&
        // Bounded before anything is fetched: a card is not worth a megabyte.
        a.size <= ICS_MAX_BYTES &&
        (/^text\/calendar\b/i.test(a.mimeType ?? "") || /\.ics$/i.test(a.name)),
    ) ?? null
  );
}

export default function InviteCard({ messageId, attachment }: { messageId: string; attachment: Attachment }) {
  const { data: event } = useQuery({
    queryKey: ["invite", messageId, attachment.partId ?? attachment.name],
    queryFn: async () =>
      parseIcs(await getAttachmentText(messageId, attachment.name, attachment.partId, ICS_MAX_BYTES)),
    // The file never changes; do not fetch it again on every focus.
    staleTime: Infinity,
    retry: false,
  });
  // Not a calendar after all, unreadable, or still loading: the attachment
  // chip is there either way, so there is nothing to apologise for.
  if (!event) return null;

  const when = formatIcsWhen(event);
  const organizer = event.organizer
    ? [event.organizer.name, event.organizer.email].filter(Boolean).join(", ")
    : "";
  return (
    <section
      aria-label="Calendar invite"
      // Phone: the download goes under the details. Beside them it left the
      // address and the organizer a column a few letters wide.
      className="mx-4 mb-3 flex items-start gap-3 rounded-md border bg-muted/40 px-3 py-2.5 text-sm max-md:flex-wrap"
    >
      <CalendarDays className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5 max-md:basis-[calc(100%-1.75rem)]">
        <p className="font-medium [overflow-wrap:anywhere]">
          {event.cancelled && <span className="mr-1.5 text-destructive">Cancelled:</span>}
          {event.title || "(untitled event)"}
        </p>
        {when ? (
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {when}
            {event.allDay && ", all day"}
            {event.recurring && (
              <span className="ml-2 inline-flex items-center gap-1 align-baseline">
                <Repeat className="size-3" aria-hidden />
                Repeats
              </span>
            )}
          </p>
        ) : (
          <p className="text-muted-foreground">No time given</p>
        )}
        {/* A time written with no zone cannot be converted: say what was done. */}
        {event.floating && !event.allDay && when && (
          <p className="text-xs text-muted-foreground">The invite gives no time zone. Shown as written.</p>
        )}
        {event.location && (
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Location: </span>
            <span className="[overflow-wrap:anywhere]">{event.location}</span>
          </p>
        )}
        {organizer && (
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <User className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Organizer: </span>
            <span className="[overflow-wrap:anywhere]">{organizer}</span>
          </p>
        )}
      </div>
      <a
        data-print-hide
        href={attachmentUrl(messageId, attachment.name, attachment.partId)}
        download={attachment.name}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium text-foreground no-underline transition-colors hover:bg-accent max-md:ml-7 max-md:h-11 max-md:px-3"
      >
        <Download className="size-3.5" aria-hidden />
        Download .ics
      </a>
    </section>
  );
}
