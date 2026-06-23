import { describe, it, expect } from "vitest";
import {
  describeMatcher,
  describeAction,
  routingBadge,
  forwardingSummary,
  hasExternalMailProvider,
  receivingState,
  sendingState,
} from "@/lib/domains";
import type { DomainDetail } from "@/lib/types";

describe("describeMatcher", () => {
  it("renders catch-all, literal, and unknown matchers", () => {
    expect(describeMatcher({ type: "all" })).toBe("All mail");
    expect(describeMatcher({ type: "literal", field: "to", value: "sales@a.com" })).toBe("To is sales@a.com");
    expect(describeMatcher({ type: "weird", value: "x" })).toBe("weird: x");
    expect(describeMatcher({ type: "weird" })).toBe("weird");
  });
});

describe("describeAction", () => {
  it("renders forward/drop/worker and unknown actions", () => {
    expect(describeAction({ type: "forward", value: ["a@x.com", "b@x.com"] })).toBe("Forward to a@x.com, b@x.com");
    expect(describeAction({ type: "forward", value: [] })).toBe("Forward");
    expect(describeAction({ type: "drop" })).toBe("Drop (discard)");
    expect(describeAction({ type: "worker", value: ["my-worker"] })).toBe("Worker: my-worker");
    expect(describeAction({ type: "mystery", value: ["v"] })).toBe("mystery: v");
  });
});

describe("routingBadge", () => {
  it("maps routing state to a labelled badge", () => {
    expect(routingBadge(null)).toEqual({ label: "Not set up", variant: "outline" });
    expect(routingBadge({ enabled: true, status: "ready" })).toEqual({ label: "Active", variant: "default" });
    expect(routingBadge({ enabled: true, status: "syncing" })).toEqual({ label: "syncing", variant: "secondary" });
    expect(routingBadge({ enabled: false, status: "misconfigured" })).toEqual({ label: "Misconfigured", variant: "destructive" });
    expect(routingBadge({ enabled: false, status: "" })).toEqual({ label: "Disabled", variant: "outline" });
    // "unknown" = settings fetch failed, not a definite state.
    expect(routingBadge({ enabled: false, status: "unknown" })).toEqual({ label: "Couldn't load", variant: "secondary" });
  });
});

describe("forwardingSummary", () => {
  const base: DomainDetail = { zoneId: "z", name: "a.com", routing: null, rules: [], catchAll: null, destinations: [], mx: [], sending: [] };

  it("summarizes a catch-all forward", () => {
    const d: DomainDetail = { ...base, catchAll: { enabled: true, actions: [{ type: "forward", value: ["me@x.com"] }] } };
    expect(forwardingSummary(d)).toBe("Forward to me@x.com");
  });

  it("summarizes a catch-all drop", () => {
    const d: DomainDetail = { ...base, catchAll: { enabled: true, actions: [{ type: "drop" }] } };
    expect(forwardingSummary(d)).toBe("Catch-all: drop");
  });

  it("falls back to custom rule count, then to none", () => {
    expect(forwardingSummary({ ...base, rules: [
      { id: "1", name: "r", enabled: true, matchers: [], actions: [] },
    ] })).toBe("1 custom rule");
    expect(forwardingSummary(base)).toBe("No forwarding");
  });
});

const BASE: DomainDetail = {
  zoneId: "z",
  name: "a.com",
  routing: null,
  rules: [],
  catchAll: null,
  destinations: [],
  mx: [],
  sending: [],
};
const ACTIVE = { enabled: true, status: "ready" };

describe("hasExternalMailProvider", () => {
  it("detects a foreign apex MX, ignoring subdomain MX and Cloudflare routing MX", () => {
    expect(hasExternalMailProvider({ ...BASE, mx: [{ name: "a.com", content: "aspmx.l.google.com", priority: 1 }] })).toBe(true);
    expect(hasExternalMailProvider({ ...BASE, mx: [{ name: "a.com", content: "route1.mx.cloudflare.net", priority: 1 }] })).toBe(false);
    expect(hasExternalMailProvider({ ...BASE, mx: [{ name: "mg.a.com", content: "mxa.mailgun.org", priority: 1 }] })).toBe(false);
    expect(hasExternalMailProvider(BASE)).toBe(false);
  });
});

describe("receivingState", () => {
  it("inbox when the catch-all targets this Worker", () => {
    const d: DomainDetail = {
      ...BASE,
      routing: ACTIVE,
      catchAll: { enabled: true, actions: [{ type: "worker", value: ["mailcove"] }] },
    };
    expect(receivingState(d)).toEqual({ kind: "inbox" });
    // A different worker is NOT this inbox.
    const other: DomainDetail = {
      ...d,
      catchAll: { enabled: true, actions: [{ type: "worker", value: ["someone-else"] }] },
    };
    expect(receivingState(other).kind).not.toBe("inbox");
  });

  it("forward / drop states from the catch-all", () => {
    expect(
      receivingState({
        ...BASE,
        routing: ACTIVE,
        catchAll: { enabled: true, actions: [{ type: "forward", value: ["me@x.com"] }] },
      }),
    ).toEqual({ kind: "forward", to: "me@x.com" });
    expect(
      receivingState({ ...BASE, routing: ACTIVE, catchAll: { enabled: true, actions: [{ type: "drop" }] } }).kind,
    ).toBe("drop");
    // Disabled catch-all → effectively dropping.
    expect(
      receivingState({ ...BASE, routing: ACTIVE, catchAll: { enabled: false, actions: [] } }).kind,
    ).toBe("drop");
  });

  it("external when routing is off and another provider holds the apex MX; off otherwise", () => {
    expect(
      receivingState({ ...BASE, mx: [{ name: "a.com", content: "aspmx.l.google.com", priority: 1 }] }).kind,
    ).toBe("external");
    expect(receivingState(BASE).kind).toBe("off");
  });
});

describe("sendingState", () => {
  it("apex / subdomain / off, only counting enabled sending domains in this zone", () => {
    expect(sendingState({ ...BASE, sending: [{ id: "1", name: "a.com", enabled: true }] })).toEqual({ kind: "apex" });
    expect(sendingState({ ...BASE, sending: [{ id: "1", name: "send.a.com", enabled: true }] })).toEqual({
      kind: "subdomain",
      via: "send.a.com",
    });
    expect(sendingState({ ...BASE, sending: [{ id: "1", name: "a.com", enabled: false }] }).kind).toBe("off");
    expect(sendingState(BASE).kind).toBe("off");
  });
});
