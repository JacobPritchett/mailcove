// Shared frontend types, mirroring the Worker API contract in src/index.ts.

export const VIEWS = ["inbox", "starred", "sent", "all", "trash", "spam", "snoozed"] as const;
export type View = (typeof VIEWS)[number];
/**
 * Sidebar navigation views: the server-backed thread views plus Drafts, which
 * is its own store (/api/drafts) and must never reach /api/messages?view=.
 */
export type NavView = View | "drafts";

export const MAIL_ACTIONS = [
  "archive", "unarchive", "trash", "restore", "delete",
  "star", "unstar", "read", "unread",
  "spam", "unspam",
  // `snooze` needs an `until` (epoch ms, in the future) alongside it.
  "snooze", "unsnooze",
] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];

/** One conversation row from GET /api/messages?view=… (server-collapsed). */
export interface ThreadListRow {
  thread_id: string;
  id: string;
  msg_from: string;
  msg_to: string;
  subject: string;
  snippet: string;
  date: number;
  count: number;
  anyUnread: 0 | 1;
  hasAttachments: 0 | 1;
  starred: 0 | 1;
  /** AI auto-label of the latest message; null = uncategorized (treat as primary). */
  category: string | null;
  /** Identity domain of the latest message (multi-domain inbox). */
  domain?: string | null;
  /** What a view is ordered by: the latest message, or when a snooze ended. */
  sort_date?: number;
  /** When a snoozed thread comes back (epoch ms); null or absent when not snoozed. */
  snoozedUntil?: number | null;
}
export interface ThreadsResponse {
  threads: ThreadListRow[];
  unread: number;
  user: string;
  /** Hand back as `cursor` for the next page; null or absent at the end. */
  nextCursor?: string | null;
}
/** Per-domain inbox counts for the sidebar's inbox switcher. */
export interface DomainCount { domain: string; threads: number; unread: number; }
export interface ViewCounts {
  inbox: number; starred: number; sent: number; all: number; trash: number; inboxUnread: number;
  /** Present once the Worker reports per-domain inbox counts. */
  domains?: DomainCount[];
  /** Saved drafts count (absent on Workers predating the drafts store). */
  drafts?: number;
  /** Threads in Junk (absent on Workers predating it). */
  spam?: number;
  /** Threads snoozed and still waiting. */
  snoozed?: number;
}

/** One entry of the block list: an address, or a whole domain as "@example.com". */
export interface BlockedSender {
  address: string;
  created: number;
}
export interface BlockedResponse { blocked: BlockedSender[]; }

/** A row from the `messages` table as returned by list/detail endpoints. */
export interface MessageRow {
  id: string;
  thread_id: string;
  direction: "in" | "out";
  folder: string;
  msg_from: string;
  msg_to: string;
  /** Only present on the detail endpoint (SELECT *); nullable column → may be null. */
  msg_cc?: string | null;
  subject: string;
  snippet: string;
  /** Epoch milliseconds. */
  date: number;
  unread: 0 | 1;
  has_attachments: 0 | 1;
  /** Only present on the detail endpoint; nullable column → may be null. */
  message_id?: string | null;
  /** Only present on the detail endpoint; nullable column → may be null. */
  in_reply_to?: string | null;
  /** Only present on the detail endpoint (SELECT *); nullable column → may be null. */
  r2_raw_key?: string | null;
  /** New optional detail columns from PR B schema. */
  state?: string;
  starred?: 0 | 1;
  trashed_at?: number | null;
  domain?: string | null;
  /** 1 when the message is in Junk (trash with the junk mark). Thread detail only. */
  spam?: 0 | 1;
  /** When a snoozed message comes back (epoch ms). Thread detail only. */
  snoozed_until?: number | null;
  /** Normalized SMTP envelope recipient (RCPT TO), when captured by the Worker. */
  envelope_to?: string | null;
  /** Authenticated sender mailbox (parsed.from.address) — the image-allowlist
   *  key. null on pre-existing rows. Use this, not msg_from, to trust a sender. */
  from_addr?: string | null;
}

export interface Attachment {
  /** MIME part id. Names are not unique within a message; this is. Absent on
   *  messages stored before the Worker recorded it. */
  partId?: string;
  name: string;
  mimeType: string;
  size: number;
  /** Set on inline (cid:) parts, which the body already displays. */
  contentId?: string | null;
  disposition?: string;
  /** False when the bytes were never written (over the per-message cap, or
   *  the write failed). The name is still worth showing; the link is not. */
  stored?: boolean;
}

/** A mailbox with its display name, as parsed from a header. */
export interface MailboxRef {
  name: string;
  address: string;
}

export type AuthVerdict = "pass" | "fail" | "none";

/** Header details stored beside the body (src/mailHeaders.ts). All optional:
 *  mail stored before they were captured simply lacks them. */
export interface StoredHeaders {
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: MailboxRef[];
  to?: MailboxRef[];
  cc?: MailboxRef[];
  bcc?: MailboxRef[];
  unsubscribe?: { url?: string; mailto?: { address: string; subject: string }; oneClick: boolean };
  auth?: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
}

export interface MessageBody {
  text: string;
  html: string;
  attachments: Attachment[];
  /** `text` was derived from the HTML part; the HTML is the real body. */
  textDerived?: boolean;
  /** The Worker stores RFC822 header echoes alongside the body (src/index.ts). */
  headers?: StoredHeaders;
}

/** GET /api/messages?folder=…&q=… */
export interface MessagesResponse {
  messages: MessageRow[];
  unread: number;
  user: string;
}

/** GET /api/messages/:id */
export interface MessageDetail {
  message: MessageRow;
  body: MessageBody;
}

// ---- Drafts (autosaved compose state) ----

/** One row in GET /api/drafts. */
export interface DraftSummary {
  id: string;
  threadId: string | null;
  to: string;
  subject: string;
  snippet: string;
  attachmentCount: number;
  updated: number;
}
export interface DraftsResponse {
  drafts: DraftSummary[];
}
/** GET /api/drafts/:id — everything needed to resume composing. */
export interface DraftFull {
  id: string;
  threadId: string | null;
  inReplyTo: string | null;
  to: string;
  /** Absent on a Worker that predates Cc/Bcc drafts. */
  cc?: string;
  bcc?: string;
  subject: string;
  bodyText: string;
  /** Stringified TipTap document — faithful rich resume. "" = use bodyText. */
  bodyJson: string;
  fromLocal: string;
  fromDomain: string;
  fromName: string;
  /** Metadata only — the bytes come from GET /api/drafts/:id/attachments. */
  attachments: DraftAttachmentMeta[];
  updated: number;
}

export interface DraftAttachmentMeta {
  name: string;
  type: string;
  size: number;
}
/** PUT /api/drafts/:id body (id rides in the URL). */
export interface DraftPut {
  threadId?: string;
  inReplyTo?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyText?: string;
  bodyJson?: string;
  fromLocal?: string;
  fromDomain?: string;
  fromName?: string;
}

/** One selectable From identity (GET /api/identities). */
export interface SendIdentity {
  /** Identity (apex) domain — what recipients see and reply to. */
  domain: string;
  /** Onboarded Email Sending domain carrying the transport From header. */
  sendingDomain: string;
  displayName: string;
  /** Plain-text signature seeded into new messages from this identity. */
  signature: string;
}
export interface IdentitiesResponse {
  identities: SendIdentity[];
  defaultLocal: string;
  defaultDomain: string;
}

/** POST /api/send body. */
export interface SendPayload {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Full identity address ("local@domain") — must match a sendable identity. */
  from?: string;
  fromLocal?: string;
  fromName?: string;
  // PR6 (threading): /api/threads/:id endpoint + In-Reply-To send wiring land in PR6; declared here for the typed client.
  inReplyTo?: string;
  threadId?: string;
  /** Files to send, base64-encoded. */
  attachments?: { filename: string; type: string; data: string }[];
}

/** A thread message row carries its body inline for the conversation reader. */
export interface ThreadMessage extends MessageRow {
  body: MessageBody;
  /** Count of remote images blocked for privacy (0 when none or already shown). */
  remoteImageCount?: number;
  /** True when this message's remote images are already proxied/shown. */
  remoteShown?: boolean;
}

/** GET /api/messages/:id/body?images=1 */
export interface BodyImagesResponse {
  html: string;
  remoteShown: boolean;
  remoteImageCount: number;
}

/** GET /api/threads/:id — all messages in the thread, oldest→newest, with bodies. */
export interface ThreadResponse {
  thread_id: string;
  messages: ThreadMessage[];
  /** Messages in the whole thread; `messages` holds at most the newest 100. */
  total?: number;
  truncated?: boolean;
}

/** GET /api/me */
export interface Me {
  email: string | null;
}

// ---- Domains admin (read-only Email Routing dashboard) ----

/** One zone in GET /api/domains. */
export interface DomainSummary {
  zoneId: string;
  name: string;
  zoneStatus: string;
  paused: boolean;
}
export interface DomainsResponse {
  domains: DomainSummary[];
  /** This inbox's Worker name — how the UI recognizes "catch-all → this inbox". */
  inboxWorker?: string | null;
}

export interface RoutingMatcher { type: string; field?: string; value?: string; }
export interface RoutingAction { type: string; value?: string[]; }
export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority?: number;
  matchers: RoutingMatcher[];
  actions: RoutingAction[];
}
export interface CatchAll { enabled: boolean; actions: RoutingAction[]; }
export interface Destination { email: string; verified: boolean; }
export interface MxRecord { name: string; content: string; priority: number; }
export interface SendingDomain { id: string; name: string; enabled: boolean; }

/** GET /api/domains/:zoneId — full Email Routing detail for one zone. */
export interface DomainDetail {
  zoneId: string;
  name: string;
  routing: { enabled: boolean; status: string } | null;
  rules: RoutingRule[];
  catchAll: CatchAll | null;
  destinations: Destination[];
  mx: MxRecord[];
  /** Email Sending domains onboarded in this zone (apex and/or subdomains). */
  sending: SendingDomain[];
}
export interface DomainDetailResponse { detail: DomainDetail; }

/** POST /api/domains/:zoneId/receiving body modes. */
export type ReceivingMode = "inbox" | "forward" | "drop";
/** Per-address rule actions ("inbox" = deliver to this Worker). */
export type RuleActionKind = "inbox" | "forward" | "drop";
/** GET /api/domains/:zoneId/settings. */
export interface DomainSettings {
  /** null = global default, "" = off, address = copy there. */
  forwardCopyTo: string | null;
  forwardCopyDefault: string | null;
  /** Sender profile: From name on outgoing mail; null = derived default. */
  displayName: string | null;
  /** The derived name used when displayName is null (e.g. "Example"). */
  displayNameDefault: string;
  /** Plain-text signature seeded into new messages; null = none. */
  signature: string | null;
}
/** PATCH /api/domains/:zoneId/settings — partial; only present fields change. */
export interface DomainSettingsPatch {
  forwardCopyTo?: string | null;
  displayName?: string | null;
  signature?: string | null;
}
/** POST /api/domains/:zoneId/sending response. */
export interface ConnectSendingResponse {
  ok: true;
  sendingDomain: string;
  dns: { created: number; skipped: number; errors: string[] };
  /** True when no DMARC was created because the domain's mail is hosted elsewhere. */
  dmarcSkipped?: boolean;
}

// ---- Inbox filters/rules ----
export const FILTER_FIELDS = ["from", "to", "subject"] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];
export const FILTER_OPS = ["contains", "equals"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const FILTER_ACTIONS = ["archive", "trash", "star", "read"] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];

export interface Filter {
  id: string;
  field: FilterField;
  op: FilterOp;
  value: string;
  action: FilterAction;
  enabled: 0 | 1;
  position: number;
}
export interface FiltersResponse { filters: Filter[]; }
export interface NewFilter { field: FilterField; op: FilterOp; value: string; action: FilterAction; }

/** A recipient suggestion derived from mail already exchanged. */
export interface Contact {
  email: string;
  name: string;
}
