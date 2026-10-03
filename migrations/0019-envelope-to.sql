-- Record the SMTP envelope recipient (RCPT TO) of inbound mail: the address the
-- message was actually delivered to. The To/Cc headers can be missing or
-- misleading for Bcc, lists and catch-all delivery, so a reply or an
-- unsubscribe request that should come from "the address this was sent to"
-- needs the envelope value. NULL on mail stored before this migration; the
-- client falls back to the To/Cc address on the message's domain.
ALTER TABLE messages ADD COLUMN envelope_to TEXT;
