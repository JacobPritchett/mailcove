# Deploying Mailcove

This guide takes a fresh Cloudflare account from nothing to a working inbox. The order
matters. Several of these resources do not get created by `wrangler deploy`, and a
missing one causes silent failures (no mail arrives, sends are rejected, or the API
returns 401).

Prerequisites:

- A domain already added to Cloudflare (this guide calls it `example.com`).
- Node 20 or newer, and `npm install` run once in the repo.
- Wrangler authenticated: `npx wrangler login`.

## 1. Create D1 and R2

```bash
npx wrangler d1 create mailcove
npx wrangler r2 bucket create mailcove-mail
```

Copy the `database_id` that `d1 create` prints into `wrangler.jsonc` under
`d1_databases[0].database_id` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

## 2. Apply the database migrations

Migrations live in `migrations/` (`NNNN-name.sql`, applied in order) and are tracked by
Cloudflare's D1 migrations framework (a `d1_migrations` table), so each runs exactly
once. The full schema is also in `schema.sql` for reference.

```bash
# remote (production); also run automatically by `npm run deploy`
npm run migrate:remote      # wrangler d1 migrations apply mailcove --remote

# local (for wrangler dev)
npm run migrate             # wrangler d1 migrations apply mailcove --local
```

After deploy is wired up (step 8), `npm run deploy` applies pending migrations before
shipping the Worker, so the live schema never drifts behind the code. To add a schema
change later: drop a new `migrations/NNNN-name.sql`, update `schema.sql`, and the next
deploy applies it.

`migrations/0007-domains.sql` contains an example seed row for `example.com`. Edit it to
your domain before applying, or remove the INSERT and add your domain through the in-app
onboarding flow after first run.

Verify the tables exist:

```bash
npx wrangler d1 execute mailcove --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

## 3. Set the config vars

Edit the `vars` block in `wrangler.jsonc`:

- `INBOX_DOMAIN`: your apex domain, for example `example.com`.
- `FROM_DOMAIN`: your Email Sending subdomain, for example `send.example.com`. This is
  the only domain authorized to send. Do not set it to the apex.
- `DEFAULT_FROM_LOCAL`: the default local part for outbound mail, for example `hello`.
- `FORWARD_COPY_TO`: an address to receive a backup copy of inbound mail, or empty to
  disable.
- `CF_ACCOUNT_ID`: your Cloudflare account id.
- `INBOX_WORKER_NAME`: keep it equal to the Worker `name` (`mailcove`).
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`: filled in step 6.
- `VAPID_PUBLIC` and `VAPID_SUBJECT`: filled in step 7.

## 4. Enable Email Routing (inbound)

In the Cloudflare dashboard, open your domain, then Email, then Email Routing, and
enable it. This adds the required MX and TXT records to your zone. Verify the
destination address if you set `FORWARD_COPY_TO`.

Then set the catch-all action to send to this Worker:

- Catch-all address: Active.
- Action: Send to a Worker, and choose `mailcove`.

Every message to any address at your domain is then delivered to the Worker's `email()`
handler. (The Worker must be deployed at least once before it appears in the Worker
list. If it is not there yet, do step 8 first, then return here.)

## 5. Enable Email Sending (outbound)

Outbound uses the `send_email` binding, which requires an onboarded Email Sending
domain. In Email settings, set up your sending subdomain (`send.example.com`) and add
the DNS records it asks for (SPF, DKIM, DMARC). Wait until it shows as verified.

The `send_email` binding in `wrangler.jsonc` does not need an API key. It is authorized
through the verified sending domain on your account.

## 6. Set up Cloudflare Access

The inbox hostname must be protected by Access. The Worker independently verifies the
Access JWT, but Access is what puts a login in front of the UI.

1. Create an Access application of type self-hosted over `inbox.example.com`.
2. Add a policy that allows only the identities you want (for example, your email).
3. After creating the application, copy two values into `wrangler.jsonc`:
   - `ACCESS_TEAM_DOMAIN`: your team domain, for example `your-team.cloudflareaccess.com`.
   - `ACCESS_AUD`: the Application Audience (AUD) tag of the application.

The Worker checks the JWT issuer (`https://<ACCESS_TEAM_DOMAIN>`) and audience
(`ACCESS_AUD`) on every `/api/*` request. A request without a valid Access JWT and
without a valid `Bearer AUTH_TOKEN` returns 401.

## 7. Generate VAPID keys for Web Push (optional)

Push notifications use VAPID keys. Generate a fresh pair (for example with the
`web-push` CLI: `npx web-push generate-vapid-keys`). Then:

- Put the public key in `wrangler.jsonc` as `VAPID_PUBLIC`.
- Set the private key as a Worker secret: `npx wrangler secret put VAPID_PRIVATE`.
- Set `VAPID_SUBJECT` to a `mailto:` address you control.

Never commit the private key, and never reuse a key pair across deployments. If you skip
this step, push notifications are disabled and the rest of the app works normally.

## 8. Set secrets and deploy

```bash
npx wrangler secret put AUTH_TOKEN        # bearer fallback for automation (see SECURITY.md)
npx wrangler secret put CF_API_TOKEN      # scoped token for in-app domain onboarding
npx wrangler secret put VAPID_PRIVATE     # only if you did step 7

npm run build
npm run deploy   # applies pending D1 migrations, then deploys the Worker
```

`CF_API_TOKEN` only needs the scopes used in `src/cf_routing.ts` (Zone read, Email
Routing, DNS read for the onboarding flow). If you do not use the in-app domain
onboarding, you can leave it unset.

## 9. Test inbound and outbound

```bash
# the hostname should redirect to the Access login (302), not return 200
curl -I https://inbox.example.com/
```

A 302 to the Access login confirms the deploy is live and Access is in front. A 200
would mean Access is not protecting the hostname.

Then:

- Send an email from an outside account to any address at your domain. It should appear
  in the inbox within a few seconds. Tail logs with `npx wrangler tail mailcove` if it
  does not.
- Sign in to the UI and send a message. It should arrive from
  `<local>@send.example.com` with a Reply-To at your apex.

## Optional: push-to-deploy with Workers Builds

If you want pushes to `main` to build and deploy automatically, connect the repo under
Workers and Pages, then your Worker, then Settings, then Builds, and authorize the
Cloudflare GitHub App for your fork. Suggested settings:

| Setting           | Value                     |
| ----------------- | ------------------------- |
| Build command     | `npm ci && npm run build` |
| Deploy command    | `npm run deploy`          |
| Root directory    | `/`                       |
| Production branch  | `main`                    |

`npm run deploy` runs `wrangler d1 migrations apply --remote` before
`wrangler deploy`, so schema migrations ship with the code automatically.

There is no GitHub Actions workflow in this repo, so nothing auto-deploys until you set
this up.
