import { describe, it, expect } from "vitest";
import { parseMailto, mailtoFromSearch } from "@/lib/mailto";

const EMPTY = { to: "", cc: "", bcc: "", subject: "", body: "" };

describe("parseMailto: scheme", () => {
  it("returns null for anything that is not a mailto: URL", () => {
    for (const bad of [
      "",
      "   ",
      "a@b.com",
      "https://example.com/?x=mailto:a@b.com",
      "javascript:alert(1)",
      "mailto",
      "mail to:a@b.com",
      "xmailto:a@b.com",
    ]) {
      expect(parseMailto(bad)).toBeNull();
    }
  });

  it("matches the scheme case-insensitively and tolerates outer whitespace", () => {
    expect(parseMailto("MAILTO:a@b.com")).toEqual({ ...EMPTY, to: "a@b.com" });
    expect(parseMailto("  \n MailTo:a@b.com \t ")).toEqual({ ...EMPTY, to: "a@b.com" });
  });

  it("returns empty fields for a bare mailto:", () => {
    expect(parseMailto("mailto:")).toEqual(EMPTY);
    expect(parseMailto("mailto:?")).toEqual(EMPTY);
  });

  it("returns null instead of throwing on a non-string", () => {
    for (const bad of [null, undefined, 42, {}, ["mailto:a@b.com"]]) {
      expect(parseMailto(bad as unknown as string)).toBeNull();
    }
  });
});

describe("parseMailto: recipients", () => {
  it("reads a comma-separated path", () => {
    expect(parseMailto("mailto:a@x.com,b@y.com")?.to).toBe("a@x.com, b@y.com");
    expect(parseMailto("mailto:a@x.com%2C%20b@y.com")?.to).toBe("a@x.com, b@y.com");
  });

  it("adds to= hfields to the path, and combines repeated to/cc/bcc", () => {
    const r = parseMailto(
      "mailto:a@x.com?to=b@x.com&cc=c@x.com&to=d@x.com,e@x.com&bcc=f@x.com&cc=g@x.com&bcc=h@x.com",
    );
    expect(r).toEqual({
      ...EMPTY,
      to: "a@x.com, b@x.com, d@x.com, e@x.com",
      cc: "c@x.com, g@x.com",
      bcc: "f@x.com, h@x.com",
    });
  });

  it("matches hfield names case-insensitively, including percent-encoded names", () => {
    const r = parseMailto("mailto:?TO=a@x.com&Cc=b@x.com&BCC=c@x.com&SUBJECT=s&Body=b&%73ubject=late");
    expect(r).toEqual({ to: "a@x.com", cc: "b@x.com", bcc: "c@x.com", subject: "s", body: "b" });
  });

  it("splits on the first ? only, before percent-decoding", () => {
    // An encoded ? belongs to the path, so it must not start the hfields. The
    // path is then one string that is not a valid address.
    expect(parseMailto("mailto:a@x.com%3Fsubject=no")).toEqual(EMPTY);
    expect(parseMailto("mailto:who%3F@x.com?subject=yes")).toEqual({ ...EMPTY, to: "who?@x.com", subject: "yes" });
    // A second literal ? is just text inside the hfields.
    expect(parseMailto("mailto:a@x.com?subject=why?&body=b")).toEqual({
      ...EMPTY,
      to: "a@x.com",
      subject: "why?",
      body: "b",
    });
  });

  it("keeps only the bare address from Name <addr> forms", () => {
    expect(parseMailto("mailto:Ann%20Lee%20%3Cann@x.com%3E")?.to).toBe("ann@x.com");
    expect(parseMailto("mailto:?cc=%22Lee%2C%20Ann%22%20%3Cann@x.com%3E,<bob@y.com>")?.cc).toBe(
      "ann@x.com, bob@y.com",
    );
  });

  it("does not change the case of an address", () => {
    expect(parseMailto("mailto:Ann.Lee@Example.COM")?.to).toBe("Ann.Lee@Example.COM");
  });

  it("keeps + literal in addresses (it is not a space in mailto)", () => {
    expect(parseMailto("mailto:ann+tag@x.com")?.to).toBe("ann+tag@x.com");
  });

  it("drops anything that does not look like one address", () => {
    const bad = [
      "no-at",
      "a@",
      "@b.com",
      "a@b",
      "a@@b.com",
      "a@b@c.com",
      "a b@c.com",
      "a@b.com;c@d.com",
      "a@b.com>",
      "<a@b.com",
      "<<a@b.com>>",
      "a@b.com <not an address>",
      "ä@b.com",
    ];
    for (const b of bad) {
      expect(parseMailto(`mailto:${encodeURIComponent(b)}`)?.to, b).toBe("");
    }
    expect(parseMailto("mailto:nope,ok@x.com,,also bad@x.com")?.to).toBe("ok@x.com");
  });

  it("drops addresses longer than 254 characters", () => {
    const domain = "@example.com";
    const fits = "a".repeat(254 - domain.length) + domain;
    const tooLong = "a".repeat(255 - domain.length) + domain;
    expect(parseMailto(`mailto:${fits}`)?.to).toBe(fits);
    expect(parseMailto(`mailto:${tooLong}`)?.to).toBe("");
  });

  it("de-duplicates case-insensitively within a field, keeping the first spelling", () => {
    const r = parseMailto("mailto:Ann@x.com,ann@X.com?to=ANN@X.COM&cc=ann@x.com&cc=Ann@x.com");
    expect(r?.to).toBe("Ann@x.com");
    // The same address may still appear in a different field.
    expect(r?.cc).toBe("ann@x.com");
  });

  it("keeps at most 50 addresses per field", () => {
    const many = Array.from({ length: 60 }, (_, i) => `u${i}@x.com`);
    const r = parseMailto(`mailto:${many.join(",")}?cc=${many.join(",")}`);
    expect(r?.to.split(", ")).toEqual(many.slice(0, 50));
    expect(r?.cc.split(", ")).toEqual(many.slice(0, 50));
  });

  it("strips control characters from addresses before validating them", () => {
    expect(parseMailto("mailto:a%00nn@x.com")?.to).toBe("ann@x.com");
    expect(parseMailto("mailto:%E2%80%AEann@x.com")?.to).toBe("ann@x.com");
    // A header injection attempt collapses into something that is not an address.
    expect(parseMailto("mailto:ann@x.com%0D%0ABcc:%20evil@x.com")?.to).toBe("");
  });
});

describe("parseMailto: ignored hfields", () => {
  it("ignores attach and attachment (a known data exfiltration trick)", () => {
    const r = parseMailto(
      "mailto:a@x.com?attach=/etc/passwd&attachment=C:%5Csecrets.txt&ATTACH=~/.ssh/id_rsa&subject=Hi",
    );
    expect(r).toEqual({ ...EMPTY, to: "a@x.com", subject: "Hi" });
    expect(Object.keys(r ?? {}).sort()).toEqual(["bcc", "body", "cc", "subject", "to"]);
  });

  it("ignores from, reply-to, in-reply-to, and unknown names", () => {
    const r = parseMailto(
      "mailto:a@x.com?from=ceo@x.com&reply-to=evil@x.com&in-reply-to=%3Cid@x.com%3E&x-thing=1&novalue&=orphan&body=B",
    );
    expect(r).toEqual({ ...EMPTY, to: "a@x.com", body: "B" });
  });

  it("is not fooled by prototype property names", () => {
    const r = parseMailto("mailto:a@x.com?__proto__=x&constructor=y&toString=z&hasOwnProperty=q");
    expect(r).toEqual({ ...EMPTY, to: "a@x.com" });
  });
});

describe("parseMailto: subject and body", () => {
  it("percent-decodes UTF-8 and keeps + literal", () => {
    const r = parseMailto("mailto:?subject=1+1%20=%202&body=caf%C3%A9%20%F0%9F%98%80+ok");
    expect(r?.subject).toBe("1+1 = 2");
    expect(r?.body).toBe("café \u{1F600}+ok");
  });

  it("uses the first subject and the first body, even when it is empty", () => {
    expect(parseMailto("mailto:?subject=one&subject=two&body=b1&body=b2")).toEqual({
      ...EMPTY,
      subject: "one",
      body: "b1",
    });
    expect(parseMailto("mailto:?subject=&subject=two")?.subject).toBe("");
  });

  it("keeps = signs after the first one in a value", () => {
    expect(parseMailto("mailto:?body=a=b==c")?.body).toBe("a=b==c");
  });

  it("turns subject newlines into a single space (header injection)", () => {
    expect(parseMailto("mailto:?subject=Hi%0D%0ABcc:%20evil@x.com")?.subject).toBe("Hi Bcc: evil@x.com");
    expect(parseMailto("mailto:?subject=a%0Ab%0Dc%0D%0A%0D%0Ad")?.subject).toBe("a b c d");
  });

  it("strips other control characters from the subject, tab included", () => {
    expect(parseMailto("mailto:?subject=a%00b%09c%1Fd%7Fe")?.subject).toBe("abcde");
  });

  it("normalises body line endings to \\n and keeps tabs", () => {
    expect(parseMailto("mailto:?body=a%0D%0Ab%0Dc%0Ad%09e%0D%0A%0D%0Af")?.body).toBe("a\nb\nc\nd\te\n\nf");
  });

  it("strips C0, DEL, and C1 controls from the body", () => {
    expect(parseMailto("mailto:?body=a%00b%07c%1Bd%7Fe%C2%80f%C2%9Fg")?.body).toBe("abcdefg");
    // The first character past the C1 range is kept.
    expect(parseMailto("mailto:?body=a%C2%A0b")?.body).toBe("a b");
  });

  it("strips bidi overrides and isolates from every field", () => {
    const bidi = "‪‫‬‭‮⁦⁧⁨⁩";
    const enc = encodeURIComponent(bidi);
    const r = parseMailto(`mailto:a${enc}@x.com?cc=b${enc}@x.com&bcc=c${enc}@x.com&subject=s${enc}t&body=u${enc}v`);
    expect(r).toEqual({ to: "a@x.com", cc: "b@x.com", bcc: "c@x.com", subject: "st", body: "uv" });
    // Raw (not percent-encoded) controls get the same treatment.
    expect(parseMailto(`mailto:?subject=s${bidi}\u0000t&body=u${bidi}\u0085v`)).toEqual({
      ...EMPTY,
      subject: "st",
      body: "uv",
    });
  });

  it("caps the subject at 500 characters", () => {
    const r = parseMailto(`mailto:?subject=${"s".repeat(600)}`);
    expect(r?.subject).toBe("s".repeat(500));
  });

  it("does not leave half of a surrogate pair at the subject cap", () => {
    const r = parseMailto(`mailto:?subject=${"s".repeat(499)}%F0%9F%98%80`);
    expect(r?.subject).toBe("s".repeat(499));
  });
});

describe("parseMailto: malformed percent-encoding", () => {
  it("keeps escapes that are not valid hex as literal text", () => {
    expect(parseMailto("mailto:?subject=100%&body=%zz%2%20%")).toEqual({
      ...EMPTY,
      subject: "100%",
      body: "%zz%2 %",
    });
  });

  it("drops bytes that are not valid UTF-8 and decodes the rest", () => {
    expect(parseMailto("mailto:?body=a%FFb")?.body).toBe("ab");
    // A truncated multi-byte sequence followed by a valid one.
    expect(parseMailto("mailto:?body=a%C3b%C3%A9%E2%82")?.body).toBe("abé");
    // An overlong encoding of "/" must not decode to "/".
    expect(parseMailto("mailto:?body=a%C0%AFb")?.body).toBe("ab");
  });

  it("drops lone surrogates, raw or percent-encoded", () => {
    expect(parseMailto("mailto:?subject=a\ud800b&body=c\udc00d")).toEqual({
      ...EMPTY,
      subject: "ab",
      body: "cd",
    });
    expect(parseMailto("mailto:?body=a%ED%A0%80b")?.body).toBe("ab");
    // A real pair survives.
    expect(parseMailto("mailto:?body=a😀b")?.body).toBe("a\u{1F600}b");
  });

  it("never throws on hostile input", () => {
    const hostile = [
      "mailto:%",
      "mailto:%%%",
      "mailto:?%=%&%",
      "mailto:?&&&===",
      "mailto:?subject",
      "mailto:\ud800?\udfff=\ud800",
      "mailto:%00%FF%FE?body=%E0%80",
      "mailto:" + "%".repeat(9000),
      "mailto:" + ",".repeat(9000),
      "mailto:?" + "&".repeat(9000),
      "mailto:" + "<".repeat(4000) + ">".repeat(4000),
    ];
    for (const h of hostile) {
      expect(() => parseMailto(h), h.slice(0, 40)).not.toThrow();
      expect(parseMailto(h)).not.toBeNull();
    }
  });
});

describe("parseMailto: length bound", () => {
  it("truncates the input to 8000 characters before parsing", () => {
    const head = "mailto:a@x.com?body=";
    const fill = "b".repeat(8000 - head.length);
    const r = parseMailto(`${head}${fill}TAIL&cc=late@x.com`);
    expect(r).toEqual({ ...EMPTY, to: "a@x.com", body: fill });
  });

  it("parses an input of exactly 8000 characters in full", () => {
    const tail = "&cc=c@x.com";
    const head = "mailto:a@x.com?body=";
    const fill = "b".repeat(8000 - head.length - tail.length);
    expect(parseMailto(`${head}${fill}${tail}`)).toEqual({ ...EMPTY, to: "a@x.com", cc: "c@x.com", body: fill });
  });
});

describe("mailtoFromSearch", () => {
  it("returns the decoded mailto: URL from the compose parameter", () => {
    const url = "mailto:a@x.com?subject=Hi%20there&body=1+1";
    expect(mailtoFromSearch(`?compose=${encodeURIComponent(url)}`)).toBe(url);
    expect(mailtoFromSearch(`compose=${encodeURIComponent(url)}`)).toBe(url);
    expect(mailtoFromSearch(`?x=1&compose=${encodeURIComponent(url)}&y=2`)).toBe(url);
  });

  it("round-trips through parseMailto", () => {
    const url = "mailto:ann+tag@x.com?cc=b@x.com&subject=Q%26A&body=line%201%0D%0Aline%202";
    const got = mailtoFromSearch(`?compose=${encodeURIComponent(url)}`);
    expect(parseMailto(got ?? "")).toEqual({
      to: "ann+tag@x.com",
      cc: "b@x.com",
      bcc: "",
      subject: "Q&A",
      body: "line 1\nline 2",
    });
  });

  it("keeps a literal + rather than reading it as a space", () => {
    expect(mailtoFromSearch("?compose=mailto:ann+tag@x.com")).toBe("mailto:ann+tag@x.com");
  });

  it("returns null when there is no compose parameter or it is not a mailto: URL", () => {
    for (const s of [
      "",
      "?",
      "?q=mailto:a@x.com",
      "?compose",
      "?compose=",
      "?compose=1",
      "?compose=https%3A%2F%2Fevil.example%2F",
      "?compose=javascript%3Aalert(1)",
      "?xcompose=mailto:a@x.com",
    ]) {
      expect(mailtoFromSearch(s), s).toBeNull();
    }
  });

  it("uses the first compose parameter only", () => {
    expect(mailtoFromSearch("?compose=nope&compose=mailto:a@x.com")).toBeNull();
    expect(mailtoFromSearch("?compose=mailto:a@x.com&compose=mailto:b@x.com")).toBe("mailto:a@x.com");
  });

  it("never throws on malformed input", () => {
    for (const s of ["?compose=%", "?compose=%zz", "?compose=mailto%3A%FF", "?%=%", "?compose=\ud800"]) {
      expect(() => mailtoFromSearch(s), s).not.toThrow();
    }
    expect(mailtoFromSearch("?compose=mailto%3Aa@x.com%")).toBe("mailto:a@x.com%");
    expect(mailtoFromSearch(undefined as unknown as string)).toBeNull();
  });
});
