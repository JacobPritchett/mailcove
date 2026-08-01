#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const outDir = path.resolve('website/assets/screenshots');
const baseUrl = 'http://127.0.0.1:5190';
// Anchor the demo mail to the capture date so the list renders clock times rather
// than stale calendar dates. The oldest fixture is 4h back, so keep the anchor at
// or after 05:00 local to hold every message inside one calendar day.
const anchor = new Date();
if (anchor.getHours() < 5) anchor.setHours(5, 30, 0, 0);
const now = anchor.getTime();

const threads = [
  {
    thread_id: 'thread-pizza',
    id: 'msg-pizza-3',
    msg_from: 'Pepperoni Council <slice@example.com>',
    msg_to: 'Alex <hello@example.com>',
    subject: 'Friday pizza aliases are getting out of hand',
    snippet: 'toppings@ should go to the planning thread, but pineapple@ can go straight to arbitration.',
    date: now - 1000 * 60 * 11,
    count: 3,
    anyUnread: 1,
    hasAttachments: 1,
    starred: 1,
    category: 'primary',
    domain: 'example.com',
  },
  {
    thread_id: 'thread-dino',
    id: 'msg-dino-1',
    msg_from: 'Tiny Dinosaur Club <rawr@example.com>',
    msg_to: 'sam@example.com',
    subject: 'Your weekly dinosaur facts have arrived',
    snippet: 'Important update: stegosaurus spikes were not party hats, despite strong toddler arguments.',
    date: now - 1000 * 60 * 67,
    count: 1,
    anyUnread: 0,
    hasAttachments: 1,
    starred: 0,
    category: 'updates',
    domain: 'example.com',
  },
  {
    thread_id: 'thread-demo',
    id: 'msg-demo-1',
    msg_from: 'Cloudflare <no-reply@cloudflare.com>',
    msg_to: 'ops@example.com',
    subject: 'Email Routing delivered your first message',
    snippet: 'The catch-all route is active and messages are now arriving in your Worker.',
    date: now - 1000 * 60 * 121,
    count: 1,
    anyUnread: 0,
    hasAttachments: 0,
    starred: 0,
    category: 'work',
    domain: 'example.com',
  },
  {
    thread_id: 'thread-events',
    id: 'msg-events-1',
    msg_from: 'Debate Snacks Committee <snacks@example.com>',
    msg_to: 'rsvp@example.com',
    subject: 'Re: debate snacks and microphone labels',
    snippet: 'We have name tags, spare batteries, and enough chips to survive a filibuster.',
    date: now - 1000 * 60 * 240,
    count: 2,
    anyUnread: 0,
    hasAttachments: 0,
    starred: 0,
    category: 'primary',
    domain: 'example.com',
  },
];

const bodies = {
  'thread-pizza': {
    thread_id: 'thread-pizza',
    messages: [
      {
        id: 'msg-pizza-1', thread_id: 'thread-pizza', direction: 'in', folder: 'inbox',
        msg_from: 'Pepperoni Council <slice@example.com>', msg_to: 'Alex <hello@example.com>', msg_cc: null,
        subject: 'Friday pizza aliases are getting out of hand', snippet: 'Can toppings@ be a real address?',
        date: now - 1000 * 60 * 60 * 3, unread: 0, has_attachments: 0, starred: 1, domain: 'example.com', from_addr: 'slice@example.com',
        body: { text: 'Can toppings@ be a real address? The mushroom caucus wants a paper trail and the pineapple lobby is getting rowdy.', html: '<p>Can toppings@ be a real address?</p><p>The mushroom caucus wants a paper trail and the pineapple lobby is getting rowdy.</p>', attachments: [] },
        remoteImageCount: 0, remoteShown: true,
      },
      {
        id: 'msg-pizza-2', thread_id: 'thread-pizza', direction: 'out', folder: 'sent',
        msg_from: 'Alex <hello@example.com>', msg_to: 'Pepperoni Council <slice@example.com>', msg_cc: null,
        subject: 'Re: Friday pizza aliases are getting out of hand', snippet: 'Yes, I made toppings@, crust@, and emergency-garlic@.',
        date: now - 1000 * 60 * 60 * 2, unread: 0, has_attachments: 0, starred: 0, domain: 'example.com', from_addr: 'hello@example.com',
        body: { text: 'Yes, I made toppings@, crust@, and emergency-garlic@. Mailcove is routing each one separately, which is objectively the correct amount of infrastructure for pizza night.', html: '<p>Yes, I made toppings@, crust@, and emergency-garlic@.</p><p>Mailcove is routing each one separately, which is objectively the correct amount of infrastructure for pizza night.</p>', attachments: [] },
        remoteImageCount: 0, remoteShown: true,
      },
      {
        id: 'msg-pizza-3', thread_id: 'thread-pizza', direction: 'in', folder: 'inbox',
        msg_from: 'Pepperoni Council <slice@example.com>', msg_to: 'Alex <hello@example.com>', msg_cc: null,
        subject: 'Re: Friday pizza aliases are getting out of hand', snippet: 'toppings@ should go to the planning thread.',
        date: now - 1000 * 60 * 11, unread: 1, has_attachments: 1, starred: 1, domain: 'example.com', from_addr: 'slice@example.com',
        body: { text: 'Perfect. toppings@ should go to the planning thread, but pineapple@ can go straight to arbitration. Attached: the official sauce matrix.', html: '<p>Perfect. <strong>toppings@</strong> should go to the planning thread, but <strong>pineapple@</strong> can go straight to arbitration.</p><p>Attached: the official sauce matrix.</p>', attachments: [{ name: 'sauce-matrix.pdf', mimeType: 'application/pdf', size: 184320 }] },
        remoteImageCount: 0, remoteShown: true,
      },
    ],
  },
  'thread-dino': {
    thread_id: 'thread-dino',
    messages: [{
      id: 'msg-dino-1', thread_id: 'thread-dino', direction: 'in', folder: 'inbox',
      msg_from: 'Tiny Dinosaur Club <rawr@example.com>', msg_to: 'sam@example.com', msg_cc: null,
      subject: 'Your weekly dinosaur facts have arrived', snippet: 'Stegosaurus spikes were not party hats.', date: now - 1000 * 60 * 67,
      unread: 0, has_attachments: 1, starred: 0, domain: 'example.com', from_addr: 'rawr@example.com',
      body: { text: 'Important update: stegosaurus spikes were not party hats, despite strong toddler arguments.', html: '<p>Important update: stegosaurus spikes were not party hats, despite strong toddler arguments.</p>', attachments: [{ name: 'tiny-dinosaur-facts.pdf', mimeType: 'application/pdf', size: 94712 }] },
      remoteImageCount: 0, remoteShown: true,
    }],
  },
};
function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockApi(page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === '/api/me') return route.fulfill(json({ email: 'alex@example.com' }));
    if (p === '/api/counts') return route.fulfill(json({ inbox: 4, starred: 1, sent: 1, all: 6, trash: 0, inboxUnread: 1, drafts: 2, domains: [
      { domain: 'example.com', threads: 4, unread: 1 },
    ] }));
    if (p === '/api/messages') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const list = q ? threads.filter(t => `${t.subject} ${t.snippet} ${t.msg_from}`.toLowerCase().includes(q)) : threads;
      return route.fulfill(json({ threads: list, unread: 1, user: 'alex@example.com' }));
    }
    const threadMatch = p.match(/^\/api\/threads\/([^/]+)$/);
    if (threadMatch && route.request().method() === 'GET') return route.fulfill(json(bodies[threadMatch[1]] || { thread_id: threadMatch[1], messages: [] }));
    if (threadMatch && p.endsWith('/mutate')) return route.fulfill(json({ ok: true }));
    if (p.match(/^\/api\/threads\/[^/]+\/summarize$/)) return route.fulfill(json({ ok: true, summary: '• Pizza aliases are now split by topping, crust, and emergency garlic\n• pineapple@ needs a calmer destination than the main planning thread\n• Recommended next step: route pineapple@ to arbitration and keep sauce-matrix.pdf handy' }));
    if (p.match(/^\/api\/threads\/[^/]+\/draft-reply$/)) return route.fulfill(json({ ok: true, draft: 'Approved. Route pineapple@ to arbitration, keep toppings@ in the main thread, and please do not let anchovies@ page me after bedtime.' }));
    if (p === '/api/identities') return route.fulfill(json({ defaultLocal: 'hello', defaultDomain: 'example.com', identities: [
      { domain: 'example.com', sendingDomain: 'send.example.com', displayName: 'Example' },
    ] }));
    if (p === '/api/drafts') return route.fulfill(json({ drafts: [{ id: 'draft-1', threadId: null, to: 'team@example.com', subject: 'Pizza night routing notes', snippet: 'Here is the topping alias plan…', updated: now - 1000 * 60 * 20 }] }));
    if (p === '/api/domains') return route.fulfill(json({ inboxWorker: 'mailcove', domains: [
      { zoneId: 'zone-example', name: 'example.com', zoneStatus: 'active', paused: false },
    ] }));
    if (p.match(/^\/api\/domains\/[^/]+$/)) {
      const name = url.searchParams.get('name') || 'example.com';
      return route.fulfill(json({ detail: {
        zoneId: p.split('/').pop(), name, routing: { enabled: true, status: 'ready' },
        catchAll: { enabled: true, actions: [{ type: 'worker', value: ['mailcove'] }] },
        destinations: [{ email: 'backup@example.com', verified: true }],
        mx: [{ name, content: 'route1.mx.cloudflare.net', priority: 63 }],
        sending: [{ id: 'send-1', name: `send.${name}`, enabled: true }],
        rules: [
          { id: 'rule-1', name: `support@${name} → inbox`, enabled: true, matchers: [{ type: 'literal', field: 'to', value: `support@${name}` }], actions: [{ type: 'worker', value: ['mailcove'] }] },
          { id: 'rule-2', name: `billing@${name} → backup`, enabled: true, matchers: [{ type: 'literal', field: 'to', value: `billing@${name}` }], actions: [{ type: 'forward', value: ['backup@example.com'] }] },
        ],
      } }));
    }
    if (p.match(/^\/api\/domains\/[^/]+\/settings$/)) return route.fulfill(json({ forwardCopyTo: 'backup@example.com', forwardCopyDefault: '', displayName: 'Example', displayNameDefault: 'Example' }));
    if (p === '/api/filters') return route.fulfill(json({ filters: [] }));
    if (p === '/api/push/key') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'push disabled' }) });
    if (route.request().method() !== 'GET') return route.fulfill(json({ ok: true, id: 'ok' }));
    return route.fulfill(json({ ok: true }));
  });
}


async function setAppTheme(page, theme) {
  await page.evaluate((theme) => {
    localStorage.setItem('mailcove-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, theme);
}

async function screenshot(page, theme, filename) {
  await setAppTheme(page, theme);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, filename), fullPage: false });
}

async function waitForServer(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server did not start: ${url}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5190', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write(d));
  server.stderr.on('data', d => process.stderr.write(d));
  try {
    await waitForServer(baseUrl);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => localStorage.setItem('mailcove-theme', 'dark'));
    await mockApi(page);
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByText('Friday pizza aliases are getting out of hand').first().click();
    await page.getByRole('button', { name: /summarize/i }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(900);
    await screenshot(page, 'dark', 'mailcove-inbox.png');

    await page.getByRole('button', { name: 'Chat' }).click();
    await page.waitForTimeout(500);
    await screenshot(page, 'dark', 'mailcove-chat.png');
    await page.getByRole('button', { name: 'Rich' }).click();
    await page.waitForTimeout(300);

    // Frame the AI summary panel itself. Opening the inline reply first scrolls the
    // reader to the composer and pushes the summary out of the viewport, which left
    // this shot showing an empty reply box and nothing AI-related.
    await page.getByRole('button', { name: /summarize/i }).click();
    await page.waitForSelector('text=AI summary');
    await page.waitForTimeout(600);
    await screenshot(page, 'dark', 'mailcove-ai-summary.png');

    await page.keyboard.press('r');
    await page.waitForTimeout(500);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.waitForTimeout(500);
    await screenshot(page, 'dark', 'mailcove-command-palette.png');
    await page.keyboard.press('Escape');

    const search = page.getByLabel('Search messages').first();
    await setAppTheme(page, 'light');
    await search.fill('pizza');
    await page.waitForTimeout(800);
    await screenshot(page, 'light', 'mailcove-search.png');

    await page.getByLabel('Open command palette').click();
    await page.getByText('Domains (Email Routing)').click();
    await page.locator('button', { hasText: 'example.com' }).last().click({ force: true });
    await page.waitForTimeout(1200);
    await screenshot(page, 'light', 'mailcove-domains.png');

    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
