// Pure view helpers for the Domains (Email Routing) admin dashboard. Kept
// separate from the component so the human-readable rendering of CF routing
// rules is unit-testable.

import type { RoutingMatcher, RoutingAction, DomainDetail } from "./types";

/** Human-readable description of a routing matcher (what mail a rule catches). */
export function describeMatcher(m: RoutingMatcher): string {
  if (m.type === "all") return "All mail";
  if (m.type === "literal") {
    const field = m.field === "to" ? "To" : m.field || "Field";
    return `${field} is ${m.value ?? ""}`.trim();
  }
  // Unknown matcher type — show what we have rather than dropping it.
  return m.value ? `${m.type}: ${m.value}` : m.type;
}

/** Human-readable description of a routing action (where matched mail goes). */
export function describeAction(a: RoutingAction): string {
  const values = (a.value ?? []).filter(Boolean);
  switch (a.type) {
    case "forward":
      return values.length ? `Forward to ${values.join(", ")}` : "Forward";
    case "drop":
      return "Drop (discard)";
    case "worker":
      return values.length ? `Worker: ${values.join(", ")}` : "Worker";
    default:
      return values.length ? `${a.type}: ${values.join(", ")}` : a.type;
  }
}

export interface StatusBadge {
  label: string;
  /** Maps to the Badge component's `variant`. */
  variant: "default" | "secondary" | "destructive" | "outline";
}

/**
 * Summarize a zone's Email Routing state into a single badge. `routing` is null
 * when Email Routing was never provisioned for the zone.
 */
export function routingBadge(routing: DomainDetail["routing"]): StatusBadge {
  if (!routing) return { label: "Not set up", variant: "outline" };
  // "unknown" means the settings fetch failed, not that routing is absent — say
  // so rather than implying a definite state (see getRouting in cf_routing.ts).
  if (routing.status === "unknown") return { label: "Couldn't load", variant: "secondary" };
  if (routing.enabled && routing.status === "ready") return { label: "Active", variant: "default" };
  if (routing.enabled) return { label: routing.status || "Enabled", variant: "secondary" };
  if (routing.status === "misconfigured") return { label: "Misconfigured", variant: "destructive" };
  return { label: routing.status || "Disabled", variant: "outline" };
}

// ---- Onboarding state (pure, mirrors the server-side guards for display) ----

const CF_MX_SUFFIX = ".mx.cloudflare.net";

/**
 * True when the zone's APEX has MX pointing somewhere other than Cloudflare
 * Email Routing (e.g. Google Workspace) — receiving onboarding is locked for
 * such zones. Mirrors hasForeignApexMx in src/cf_routing.ts.
 */
export function hasExternalMailProvider(detail: DomainDetail): boolean {
  const apex = detail.name.toLowerCase();
  return detail.mx.some((m) => {
    if (m.name.toLowerCase() !== apex) return false;
    const host = m.content.toLowerCase().replace(/\.$/, "");
    return !host.endsWith(CF_MX_SUFFIX);
  });
}

export type ReceivingState =
  | { kind: "inbox" }
  | { kind: "forward"; to: string }
  | { kind: "drop" }
  | { kind: "external" }
  | { kind: "off" };

/** What's actually happening to inbound mail for this zone right now. */
export function receivingState(detail: DomainDetail, inboxWorker = "mailcove"): ReceivingState {
  const routingActive = !!detail.routing?.enabled && detail.routing.status === "ready";
  if (!routingActive) {
    return hasExternalMailProvider(detail) ? { kind: "external" } : { kind: "off" };
  }
  const ca = detail.catchAll;
  if (ca?.enabled) {
    if (ca.actions.some((a) => a.type === "worker" && (a.value ?? []).includes(inboxWorker))) {
      return { kind: "inbox" };
    }
    const fwd = ca.actions.find((a) => a.type === "forward");
    if (fwd) return { kind: "forward", to: (fwd.value ?? []).join(", ") };
    if (ca.actions.some((a) => a.type === "drop")) return { kind: "drop" };
  }
  return { kind: "drop" };
}

export type SendingState =
  | { kind: "apex" }
  | { kind: "subdomain"; via: string }
  | { kind: "off" };

/** Whether (and how) this zone can send: apex identity, send.* transport, or not at all. */
export function sendingState(detail: DomainDetail): SendingState {
  const apex = detail.name.toLowerCase();
  const enabled = detail.sending.filter((s) => s.enabled);
  if (enabled.some((s) => s.name.toLowerCase() === apex)) return { kind: "apex" };
  const sub = enabled.find((s) => s.name.toLowerCase().endsWith(`.${apex}`));
  if (sub) return { kind: "subdomain", via: sub.name };
  return { kind: "off" };
}

/** A one-line summary of where a domain forwards, for the master list. */
export function forwardingSummary(detail: DomainDetail): string {
  if (detail.catchAll) {
    const fwd = detail.catchAll.actions.find((a) => a.type === "forward");
    if (fwd) return describeAction(fwd);
    if (detail.catchAll.actions.some((a) => a.type === "drop")) return "Catch-all: drop";
  }
  if (detail.rules.length) return `${detail.rules.length} custom rule${detail.rules.length === 1 ? "" : "s"}`;
  return "No forwarding";
}
