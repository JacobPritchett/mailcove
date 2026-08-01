# Mailcove public website

This directory contains a static marketing site for Mailcove. It is intentionally separate from the Access-protected inbox app built into `dist/`.

## Why separate?

The product app should stay behind Cloudflare Access at an inbox hostname such as `inbox.example.com`. The marketing site should be public at a separate hostname such as:

- `mail.example.com`
- another owned product hostname

That separation keeps public SEO/positioning away from private inbox routes and avoids weakening the Access boundary. The site uses root-relative screenshot paths, so deploy it at a hostname root rather than a subpath.

## Recommended deploy: Cloudflare Pages

Create a Cloudflare Pages project pointed at this repository with:

| Setting | Value |
|---|---|
| Framework preset | None / static HTML |
| Build command | *(leave empty)* |
| Build output directory | `website` |
| Production branch | `main` |

The included `_headers` file adds conservative security headers for the public static site.

## Local preview

From the repository root:

```bash
python3 -m http.server 4173 --directory website
```

Then open `http://127.0.0.1:4173/`.

## Screenshots

The marketing page uses real screenshots from the app, stored in `website/assets/screenshots/`.

Regenerate them from the repository root with:

```bash
node scripts/capture-website-screenshots.mjs
```

The capture script starts the Vite app locally, intercepts `/api/*` with realistic demo data, and writes:

- `mailcove-inbox.png`: dark mode
- `mailcove-search.png`: light mode
- `mailcove-ai-summary.png`: dark mode thread with the AI summary panel
- `mailcove-chat.png`: dark mode chat view
- `mailcove-domains.png`: light mode
- `mailcove-command-palette.png`: dark mode

## Editing notes

- `index.html` is standalone: HTML + CSS only, no build step.
- The content is deliberately honest about fit: Mailcove is for developers and small orgs who want a Cloudflare-native custom-domain inbox, not a zero-config consumer Gmail replacement.
- Keep links to the private inbox out of the public site unless the target is an Access-protected login page you intentionally want public visitors to hit.
