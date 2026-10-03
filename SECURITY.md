# Security and privacy

Mailcove handles real email, so read this before pointing it at a live domain.

## Authentication

Every `/api/*` request is checked by `verifyAccess` in `src/auth.ts`. A request is
allowed if either of these holds:

1. It carries a valid Cloudflare Access JWT. The Worker validates the
   `Cf-Access-Jwt-Assertion` header against the Access team domain's JWKS and checks both
   the issuer (`https://<ACCESS_TEAM_DOMAIN>`) and the audience (`ACCESS_AUD`).
2. It carries `Authorization: Bearer <AUTH_TOKEN>` and the token matches the `AUTH_TOKEN`
   secret. The comparison is constant-time.

Anything else returns 401.

### The AUTH_TOKEN bearer fallback

`AUTH_TOKEN` exists for local development (where there is no Access in front of
`wrangler dev`) and for automation. Understand the tradeoff before you set it in
production:

- A valid `AUTH_TOKEN` bypasses Cloudflare Access entirely. Anyone with the token can
  call the full API, including reading mail and sending mail.
- If you set it, treat it like a password: make it long and random, set it only as a
  Worker secret (`wrangler secret put AUTH_TOKEN`), never commit it, and rotate it if it
  is exposed.
- If you do not need automation, do not set `AUTH_TOKEN` in production at all. With it
  unset, Access is the only way in.

The token is never required at build time. Nothing in the build or deploy step reads it.

## Email rendering

- Email bodies render inside a sandboxed iframe. The sandbox attribute is
  `allow-same-origin` and nothing else. There is no `allow-scripts`, so mail can never
  run code, and that is the only reason `allow-same-origin` is safe: it lets the app
  size the frame and handle clicks inside it, and the email cannot use it for anything.
- There is no `allow-popups` either. The frame never opens a tab or loads another page by
  itself. The app intercepts every click in the frame and opens the link itself, in a
  new tab with `noopener,noreferrer`, and only for `http`, `https`, and `mailto` URLs
  that do not point back at the inbox's own origin. A link the app fails to intercept
  does nothing.
- The body is wrapped in a strict Content-Security-Policy (`default-src 'none'`) that
  blocks remote loads, including tracking pixels. Inline images and allowed remote
  images are served through a signed, short-lived `/api/media` URL. Remote images load
  automatically only for mail that passed DMARC from a sender you have allowed.
- Attachments are served with `Content-Disposition: attachment` and
  `application/octet-stream`, except for an allowlist of inert image types. Every
  attachment response carries `X-Content-Type-Options: nosniff` so the browser does not
  re-sniff an octet-stream into an active type.

## Sender authentication

SPF, DKIM, and DMARC verdicts come from the `Authentication-Results` header, parsed by
`src/authResults.ts`. A header is trusted only when it was written by Cloudflare's
receiving mail server (`mx.cloudflare.net`). Mail often carries other
`Authentication-Results` headers added by earlier hops or by the sender, and those are
ignored. The header is parsed by its grammar and never searched as text, because the
envelope sender is echoed into it and can contain a string like `dmarc=pass`.

The DMARC verdict gates automatic remote images, the automatic unsubscribe paths, and
the junk rule below.

## Junk

- Mail from a sender you blocked goes to Junk.
- Otherwise a message is moved to Junk automatically only when two signals agree: the
  classifier calls it junk, and nothing vouches for it (it failed DMARC and it is not
  part of a conversation you took part in). A classifier guess alone never hides mail.
- Junk is kept for 30 days, listed under Junk, and can be restored with Not junk.
- Without the `AI` binding there is no classifier, so only blocked senders are junked.

## Unsubscribe

The Unsubscribe action uses the message's `List-Unsubscribe` header, which is the
sender's own text. The Worker sends a one-click request or an unsubscribe email only for
mail that passed DMARC. One-click requests go to `https` URLs only, never to the inbox's
own host, and redirects are not followed. An unsubscribe email is sent from the address
the message was delivered to. For mail that did not pass DMARC the reader only offers
the link for you to open.

## Workers AI and email content

If the `AI` binding is configured, Mailcove sends message content to Workers AI to
produce thread summaries, reply drafts, compose suggestions, and inbound category
labels (including the junk hint). This means the text of your email is processed by the
model. The model is `@cf/meta/llama-3.1-8b-instruct-fast`, set as a constant in
`src/ai.ts` and `src/categorize.ts`.

- Review Cloudflare's data handling terms for Workers AI before enabling it on real mail.
- If you do not want email content sent to AI, remove the `ai` binding from
  `wrangler.jsonc`. The inbox, sending, search, and threading all work without it.

## Secrets checklist

Set these as Worker secrets, never as `vars` and never in git:

- `AUTH_TOKEN` (optional in production, see above)
- `VAPID_PRIVATE` (only if you use Web Push)
- `CF_API_TOKEN` (only if you use in-app domain onboarding; scope it narrowly)

`.dev.vars` holds local secrets and is gitignored. Use `.dev.vars.example` as a template.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or contact the maintainer
listed there. Please do not open a public issue for security reports.
