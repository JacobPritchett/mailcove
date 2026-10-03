# Mailcove

A self-hosted send and receive email inbox that runs entirely on Cloudflare. One Worker
serves a React single-page app (via Workers Assets) and also runs the inbound `email()`
handler and the `/api/*` backend. Inbound mail is parsed and stored in D1 (metadata and
search) and R2 (raw `.eml`, parsed bodies, attachments). Outbound mail goes through the
`send_email` binding. The UI hostname sits behind Cloudflare Access, and the Worker
verifies the Access JWT (issuer and audience) on every API call. Messages are grouped
into conversation threads, and Workers AI can add thread summaries and reply drafts.

There are no servers to run and no mail server to maintain. Everything is a Worker plus
Cloudflare's managed email, storage, and access products.

```
inbound:  *@example.com -> Email Routing (catch-all) -> Worker email() handler
          -> parse (postal-mime) -> store raw, parsed, and attachments in R2,
             metadata in D1 -> thread the message -> optionally forward a copy

outbound: SPA -> POST /api/send -> env.EMAIL.send() (send_email binding)
          from <local>@send.example.com, Reply-To <local>@example.com

UI:       https://inbox.example.com  (React SPA, behind Cloudflare Access)
```

## Features

- Conversations: reply, reply all, and forward, with To, Cc, and Bcc on compose and on
  replies. A reply goes out from the address the original message was delivered to.
- Triage: archive, star, trash, and snooze. Snoozed mail comes back to the top of the
  inbox at the time you picked, with a push notification if you enabled Web Push.
- Junk and blocked senders: mark mail as junk, block an address or a whole domain, and
  review everything under Junk. Junk and Trash are purged after 30 days. See
  [SECURITY.md](SECURITY.md) for how the automatic junk verdict is limited.
- Search: full-text search (SQLite FTS5) plus operators: `from:`, `to:`, `cc:`,
  `subject:`, `has:attachment`, `is:unread|read|starred`,
  `in:inbox|sent|archive|snoozed|trash|spam|all|anywhere`, `before:`, `after:`,
  `older_than:`, `newer_than:`, `domain:`, `-` to exclude, and quoted phrases.
- Paging: the list loads 50 conversations at a time and fetches more as you scroll or
  move down with the keyboard. A long conversation opens on its newest 100 messages.
- Unsubscribe: when a message carries a `List-Unsubscribe` header, the reader offers an
  Unsubscribe action. One-click and mailto requests are only sent for mail that passed
  DMARC. Otherwise you get the link to open yourself.
- Phone gestures: swipe a row right to archive or left to trash, pull down to refresh,
  and long-press to select several conversations.
- Multiple domains: receive and send for more than one domain, with per-domain
  identities, display names, and signatures.
- Drafts with autosave, attachments, inbox rules, and a command palette with keyboard
  shortcuts.
- Optional Workers AI features: thread summaries, reply drafts, compose suggestions,
  and inbound category labels.
- Installable PWA with optional Web Push notifications.

## What you need

- A Cloudflare account (the free plan works to start; Workers AI and higher limits may
  need a paid plan).
- A domain on Cloudflare that you can receive mail for.
- Node 22.13 or newer and the Wrangler CLI. (The test suite uses the built-in
  `node:sqlite` module, which needs that version.)

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars   # then edit AUTH_TOKEN
npm run dev       # wrangler dev: Worker on :8787 (serves /api/* and bindings)
npm run dev:web   # vite: SPA on :5173, proxies /api to http://127.0.0.1:8787
```

Cloudflare Access is not in front of `wrangler dev`, so there is no Access JWT locally.
Instead the Worker accepts a bearer token. Put an `AUTH_TOKEN` in `.dev.vars` and call
the API with `Authorization: Bearer <token>`. `.dev.vars` is gitignored. Never commit it.

To deploy to your own Cloudflare account, follow [docs/DEPLOY.md](docs/DEPLOY.md). It
covers creating D1 and R2, applying migrations, enabling Email Routing and Email
Sending, setting up Access, and sending a first test message.

## Project layout

```
src/                 Worker (TypeScript)
  index.ts           email() handler + /api/* router + scheduled() crons
  auth.ts            verifyAccess(): Access JWT verification (jose) + AUTH_TOKEN fallback
  threading.ts       deriveThreadId() / sanitizeMessageId(): conversation grouping
  store*.ts          D1/R2 read and write helpers (views, paging, mailbox actions)
  search.ts          full-text index (FTS5)
  searchQuery.ts     search operators, turned into bound SQL predicates
  recipients.ts      To/Cc/Bcc parsing and the recipient cap
  mailHeaders.ts     stored headers: Reply-To, References, List-Unsubscribe, auth verdicts
  authResults.ts     Authentication-Results parser (SPF, DKIM, DMARC verdicts)
  junk.ts            blocked senders and the automatic junk rule
  rawGuard.ts        bounds the copy of a message the parser sees
  domains.ts         multi-domain identity registry
  cf_routing.ts      Cloudflare API client for Email Routing/Sending onboarding
  ai.ts              Workers AI: summaries, reply drafts, compose suggestions
  test/              Vitest unit tests for the Worker
app/                 React SPA (Vite + TanStack Query)
  main.tsx, App.tsx
  components/        UI, including a sandboxed email-body iframe reader
  lib/               typed /api client, queries, helpers
  test/              Vitest + Testing Library component tests
migrations/          ordered D1 migrations (0000 to 0019); they apply to an empty database
schema.sql           the same schema in one file (a test keeps the two in step)
docs/DEPLOY.md       deployment guide
wrangler.jsonc       Worker config (bindings, vars, assets, routes)
```

## Local checks

Run before every push or pull request:

```bash
npm run typecheck && npm run test && npm run build
```

`build` runs `typecheck` then `vite build`, so a type error fails the build.

The browser specs (`app/test/e2e-*.spec.ts`) run separately with Playwright. They build
the app, serve it with `vite preview`, and stub `/api/*`, so they need no Cloudflare
account:

```bash
npx playwright install chromium   # once
npm run e2e
```

## API surface

All routes are under `/api/*` and are validated by `verifyAccess` (Access JWT, or
`Bearer AUTH_TOKEN` for automation). Everything else is served by the SPA.

The main routes:

- `GET  /api/me` returns the validated signed-in email (or `null` for token auth)
- `GET  /api/messages?view=...&q=...&cursor=...` lists conversations, one page at a
  time. Views are `inbox`, `starred`, `sent`, `all`, `trash`, `spam`, and `snoozed`.
  `q` accepts the search operators listed above.
- `GET  /api/counts` returns per-view and per-domain counts
- `GET  /api/messages/:id` returns a full message (body loaded from R2)
- `GET  /api/messages/:id/raw` downloads the original message as received
- `POST /api/messages/:id/unsubscribe` acts on the message's `List-Unsubscribe` header
- `GET  /api/threads/:id` returns the messages in a conversation, oldest first (the
  newest 100 when the conversation is longer)
- `POST /api/threads/:id/mutate` and `POST /api/messages/mutate` perform mailbox
  actions (read, archive, trash, star, junk, snooze) on one or many conversations
- `GET  /api/blocked`, `POST /api/blocked`, `DELETE /api/blocked/:address` manage
  blocked senders
- `GET  /api/attachments/:id/:name` downloads an attachment
- `POST /api/send` sends a message (To, Cc, Bcc, attachments; 50 recipients at most
  across the three fields)
- `/api/drafts`, `/api/filters`, `/api/domains`, `/api/identities`, `/api/contacts`,
  and `/api/push/*` back the drafts, rules, domains, compose, and notification screens

## Cloudflare resources

- Worker `mailcove` on a custom domain such as `inbox.example.com`
- Workers Assets serving the Vite build from `dist/`
- D1 `mailcove` (binding `DB`) for message metadata and search
- R2 `mailcove-mail` (binding `MAILSTORE`) for raw `.eml`, parsed bodies, attachments
- `send_email` binding `EMAIL` for outbound, from the onboarded sending subdomain
- Email Routing with a catch-all action pointing at the Worker
- Cloudflare Access protecting the inbox hostname
- Workers AI (binding `AI`) for summaries and reply drafts
- Two cron triggers: `0 4 * * *` purges old Trash and Junk and finishes pending
  deletes, and `*/5 * * * *` wakes snoozed mail

## Security and privacy

The security model, including how the Access JWT is verified, how the `AUTH_TOKEN`
bearer fallback works and when to avoid it, how attachments and email bodies are
sandboxed, and what email content is sent to Workers AI, is documented in
[SECURITY.md](SECURITY.md). Read it before exposing a deployment to real mail.

## License

MIT. See [LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
