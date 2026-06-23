-- Safe images: store the authenticated sender mailbox separately from the
-- rendered msg_from display string. The image allowlist is matched against this
-- field, NOT msg_from — a crafted display name can inject a second "<addr>" into
-- msg_from (e.g. `"Trusted <trusted@allowlisted.com>" <attacker@evil.com>`) and
-- trick a display-string parse into matching a trusted address while the message
-- is really from the attacker's (DMARC-passing) domain. parsed.from.address
-- (postal-mime) is the real mailbox and is immune to that injection.
-- NULL on pre-existing rows → fail closed (those messages never auto-show images).
ALTER TABLE messages ADD COLUMN from_addr TEXT;
