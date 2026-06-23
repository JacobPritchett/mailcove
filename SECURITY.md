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

- Email bodies render inside a sandboxed iframe. The sandbox does not include
  `allow-scripts`, and the body is wrapped in a strict Content-Security-Policy
  (`default-src 'none'`) that blocks remote loads, including tracking pixels.
- Attachments are served with `Content-Disposition: attachment` and
  `application/octet-stream`, except for an allowlist of inert image types. Every
  attachment response carries `X-Content-Type-Options: nosniff` so the browser does not
  re-sniff an octet-stream into an active type.

## Workers AI and email content

If the `AI` binding is configured, Mailcove sends message content to Workers AI to
produce thread summaries, reply drafts, compose suggestions, and inbound category
labels. This means the text of your email is processed by the model.

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
