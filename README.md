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

## What you need

- A Cloudflare account (the free plan works to start; Workers AI and higher limits may
  need a paid plan).
- A domain on Cloudflare that you can receive mail for.
- Node 20 or newer and the Wrangler CLI.

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
  index.ts           email() handler + /api/* router + scheduled() cron
  auth.ts            verifyAccess(): Access JWT verification (jose) + AUTH_TOKEN fallback
  threading.ts       deriveThreadId() / sanitizeMessageId(): conversation grouping
  store*.ts          D1/R2 read and write helpers
  search.ts          full-text index (FTS5)
  domains.ts         multi-domain identity registry
  cf_routing.ts      Cloudflare API client for Email Routing/Sending onboarding
  ai.ts              Workers AI: summaries, reply drafts, compose suggestions
  test/              Vitest unit tests for the Worker
app/                 React SPA (Vite + TanStack Query)
  main.tsx, App.tsx
  components/        UI, including a sandboxed email-body iframe reader
  lib/               typed /api client, queries, helpers
  test/              Vitest + Testing Library component tests
migrations/          ordered D1 migrations (0001 to 0011)
schema.sql           full D1 schema (for a fresh database)
docs/DEPLOY.md       deployment guide
wrangler.jsonc       Worker config (bindings, vars, assets, routes)
```

## Local checks

Run before every push or pull request:

```bash
npm run typecheck && npm run test && npm run build
```

`build` runs `typecheck` then `vite build`, so a type error fails the build.

## API surface

All routes are under `/api/*` and are validated by `verifyAccess` (Access JWT, or
`Bearer AUTH_TOKEN` for automation). Everything else is served by the SPA.

- `GET  /api/me` returns the validated signed-in email (or `null` for token auth)
- `GET  /api/messages?view=inbox|sent&q=...` lists messages with an unread count
- `GET  /api/messages/:id` returns a full message (body loaded from R2)
- `GET  /api/threads/:id` returns every message in a conversation, oldest first
- `POST /api/messages/mutate` performs mailbox actions (read, archive, trash, star)
- `GET  /api/attachments/:id/:name` downloads an attachment
- `POST /api/send` sends a message

## Cloudflare resources

- Worker `mailcove` on a custom domain such as `inbox.example.com`
- Workers Assets serving the Vite build from `dist/`
- D1 `mailcove` (binding `DB`) for message metadata and search
- R2 `mailcove-mail` (binding `MAILSTORE`) for raw `.eml`, parsed bodies, attachments
- `send_email` binding `EMAIL` for outbound, from the onboarded sending subdomain
- Email Routing with a catch-all action pointing at the Worker
- Cloudflare Access protecting the inbox hostname
- Workers AI (binding `AI`) for summaries and reply drafts

## Security and privacy

The security model, including how the Access JWT is verified, how the `AUTH_TOKEN`
bearer fallback works and when to avoid it, how attachments and email bodies are
sandboxed, and what email content is sent to Workers AI, is documented in
[SECURITY.md](SECURITY.md). Read it before exposing a deployment to real mail.

## License

MIT. See [LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
