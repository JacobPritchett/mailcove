import { describe, it, expect } from "vitest";
import {
  addressClaimedInName,
  mailboxes,
  parseListUnsubscribe,
  referenceChain,
  referencesForReply,
  storedHeadersFrom,
} from "../mailHeaders";

describe("parseListUnsubscribe", () => {
  it("keeps the https endpoint and the mailto target", () => {
    expect(
      parseListUnsubscribe(
        "<https://news.example/unsub?u=abc>, <mailto:unsub@news.example?subject=Remove%20me>",
        "List-Unsubscribe=One-Click",
      ),
    ).toEqual({
      url: "https://news.example/unsub?u=abc",
      mailto: { address: "unsub@news.example", subject: "Remove me" },
      oneClick: true,
    });
  });

  it("is one-click only with the Post header AND an https endpoint", () => {
    expect(parseListUnsubscribe("<https://a.example/u>", undefined)?.oneClick).toBe(false);
    expect(parseListUnsubscribe("<mailto:u@a.example>", "List-Unsubscribe=One-Click")?.oneClick).toBe(false);
  });

  it("ignores plain http, other schemes, credentials and junk", () => {
    expect(parseListUnsubscribe("<http://a.example/u>", null)).toBeUndefined();
    expect(parseListUnsubscribe("<javascript:alert(1)>, <ftp://a.example>", null)).toBeUndefined();
    expect(parseListUnsubscribe("<https://user:pw@a.example/u>", null)).toBeUndefined();
    expect(parseListUnsubscribe("https://a.example/u", null)).toBeUndefined();
    expect(parseListUnsubscribe("<mailto:not an address>", null)).toBeUndefined();
    expect(parseListUnsubscribe("", null)).toBeUndefined();
  });

  it("cannot smuggle a header through the mailto subject", () => {
    const info = parseListUnsubscribe("<mailto:u@a.example?subject=hi%0d%0aBcc%3A%20x%40evil.example>", null);
    expect(info?.mailto?.subject).toBe("hi Bcc: x@evil.example");
    expect(info?.mailto?.subject).not.toMatch(/[\r\n]/);
  });

  it("stays fast on a hostile header", () => {
    const t0 = performance.now();
    parseListUnsubscribe("<".repeat(200_000), null);
    parseListUnsubscribe("<https://a.example/" + "a".repeat(200_000) + ">", null);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("addressClaimedInName", () => {
  it("flags a name that claims an address on another domain", () => {
    expect(addressClaimedInName("Chase Bank <alerts@chase.com>", "alerts@ch4se-secure.example")).toBe("alerts@chase.com");
  });
  it("is quiet when the name repeats the real domain or has no address", () => {
    expect(addressClaimedInName("alerts@chase.com", "alerts@chase.com")).toBeNull();
    expect(addressClaimedInName("Maya Okafor", "maya@okafor.example")).toBeNull();
    expect(addressClaimedInName("", "x@y.example")).toBeNull();
  });
});

describe("referenceChain / referencesForReply", () => {
  it("sanitizes, dedupes and keeps order", () => {
    expect(referenceChain("<a@x>  <b@x>\n <a@x> bad id <c@x>")).toEqual(["<a@x>", "<b@x>", "<bad>", "<id>", "<c@x>"]);
  });
  it("drops ids carrying control characters (header injection)", () => {
    expect(referenceChain(["<a@x>\r\nBcc: evil@x"])).toEqual(["<a@x>", "<Bcc:>", "<evil@x>"]);
    expect(referencesForReply(["<a@x>"], "<b@x>")).not.toMatch(/[\r\n]/);
  });
  it("appends the parent and bounds a long conversation, keeping the root", () => {
    const chain = Array.from({ length: 80 }, (_, i) => `<m${i}@x>`);
    const refs = referencesForReply(chain, "<parent@x>").split(" ");
    expect(refs).toHaveLength(30);
    expect(refs[0]).toBe("<m0@x>");
    expect(refs[refs.length - 1]).toBe("<parent@x>");
  });
});

describe("mailboxes", () => {
  it("flattens groups and drops unusable addresses", () => {
    expect(
      mailboxes([
        { name: "A", address: "a@x.example" },
        { name: "Team", group: [{ name: "B", address: "b@x.example" }, { name: "", address: "nope" }] },
        { name: "C", address: "" },
      ]),
    ).toEqual([
      { name: "A", address: "a@x.example" },
      { name: "B", address: "b@x.example" },
    ]);
  });
});

describe("storedHeadersFrom", () => {
  it("keeps Reply-To only when it differs from From", () => {
    const base = { messageId: "<m@x>", from: { name: "A", address: "a@x.example" } };
    expect(storedHeadersFrom({ ...base, replyTo: [{ name: "", address: "A@x.example" }] }).replyTo).toBeUndefined();
    expect(storedHeadersFrom({ ...base, replyTo: [{ name: "List", address: "list@x.example" }] }).replyTo).toEqual([
      { name: "List", address: "list@x.example" },
    ]);
  });
  it("uses only the FIRST Authentication-Results header", () => {
    const h = storedHeadersFrom({
      messageId: "<m@x>",
      headers: [
        { key: "authentication-results", value: "mx.cloudflare.net; dmarc=fail; spf=fail" },
        { key: "authentication-results", value: "forged; dmarc=pass; spf=pass; dkim=pass" },
        { key: "list-unsubscribe", value: "<https://a.example/u>" },
        { key: "list-unsubscribe-post", value: "List-Unsubscribe=One-Click" },
      ],
    });
    expect(h.auth).toEqual({ spf: "fail", dkim: "none", dmarc: "fail" });
    expect(h.unsubscribe).toEqual({ url: "https://a.example/u", oneClick: true });
  });
  it("cannot be talked into a pass by the envelope address or a foreign header", () => {
    const forged = storedHeadersFrom({
      messageId: "<m@x>",
      headers: [
        {
          key: "authentication-results",
          value:
            "mx.cloudflare.net; dmarc=fail header.from=example.com; spf=pass (mx.cloudflare.net: domain of dmarc=pass@evil.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=dmarc=pass@evil.example",
        },
      ],
    });
    expect(forged.auth?.dmarc).toBe("fail");
    const foreign = storedHeadersFrom({
      messageId: "<m@x>",
      headers: [{ key: "authentication-results", value: "mx.google.com; dmarc=pass; spf=pass; dkim=pass" }],
    });
    expect(foreign.auth).toEqual({ spf: "none", dkim: "none", dmarc: "none" });
    const h = forged;
    expect(h.messageId).toBe("<m@x>");
  });
  it("keeps parsing the unsubscribe headers alongside", () => {
    const h = storedHeadersFrom({
      messageId: "<m@x>",
      headers: [
        { key: "list-unsubscribe", value: "<https://a.example/u>" },
        { key: "list-unsubscribe-post", value: "List-Unsubscribe=One-Click" },
      ],
    });
    expect(h.unsubscribe).toEqual({ url: "https://a.example/u", oneClick: true });
  });
});
