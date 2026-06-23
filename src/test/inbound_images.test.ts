import { describe, it, expect } from "vitest";
import { parseAuthResults, dmarcPassFromHeaders, normalizeAddress, normalizeFromAddress, attachmentRecord } from "../index";

describe("normalizeFromAddress (anti display-name spoofing)", () => {
  it("uses the structured mailbox, immune to a display name injecting a second <addr>", () => {
    // postal-mime parses `"Trusted <trusted@allowlisted.com>" <attacker@evil.com>`
    // into name + the REAL address. The trust key must be the real address.
    expect(
      normalizeFromAddress({ address: "attacker@evil.com", name: "Trusted <trusted@allowlisted.com>" } as any),
    ).toBe("attacker@evil.com");
    // Contrast: the rendered-string parser IS spoofable (this is why we don't use it).
    expect(normalizeAddress("Trusted <trusted@allowlisted.com> <attacker@evil.com>")).toBe(
      "trusted@allowlisted.com",
    );
  });
  it("lowercases/trims and returns '' for an unparseable From", () => {
    expect(normalizeFromAddress({ address: "  Alice@Good.COM " } as any)).toBe("alice@good.com");
    expect(normalizeFromAddress(null)).toBe("");
    expect(normalizeFromAddress(undefined)).toBe("");
    expect(normalizeFromAddress({} as any)).toBe("");
  });
});

describe("parseAuthResults", () => {
  it("returns 1 when dmarc=pass present", () => {
    expect(parseAuthResults("mx.cf.net; spf=pass; dkim=pass; dmarc=pass header.from=x.com")).toBe(1);
  });
  it("returns 0 when dmarc fails or absent", () => {
    expect(parseAuthResults("mx; dmarc=fail")).toBe(0);
    expect(parseAuthResults(null)).toBe(0);
  });
});

describe("dmarcPassFromHeaders (anti-spoofing)", () => {
  it("honors ONLY the first (boundary-MX) Authentication-Results", () => {
    // CF prepends its result at the top (dmarc=fail); a forged copy lower in the
    // message claims dmarc=pass. The forged one must be ignored.
    expect(
      dmarcPassFromHeaders([
        { key: "Authentication-Results", value: "mx.cf.net; spf=fail; dmarc=fail" },
        { key: "Authentication-Results", value: "spoofed.invalid; dmarc=pass" },
        { key: "From", value: "trusted@allowlisted.com" },
      ]),
    ).toBe(0);
  });
  it("returns 1 when the first (trusted) result is dmarc=pass", () => {
    expect(
      dmarcPassFromHeaders([
        { key: "authentication-results", value: "mx.cf.net; dmarc=pass header.from=x.com" },
        { key: "authentication-results", value: "whatever; dmarc=fail" },
      ]),
    ).toBe(1);
  });
  it("returns 0 when there is no Authentication-Results header", () => {
    expect(dmarcPassFromHeaders([{ key: "From", value: "a@b.com" }])).toBe(0);
    expect(dmarcPassFromHeaders([])).toBe(0);
    expect(dmarcPassFromHeaders(undefined)).toBe(0);
  });
});

describe("attachmentRecord", () => {
  it("assigns a partId and normalizes contentId", () => {
    const rec = attachmentRecord({ filename: "Logo.PNG", mimeType: "image/png", size: 9, contentId: "<Logo@x>", disposition: "inline" }, 0);
    expect(rec.partId).toMatch(/^p0$/);
    expect(rec.contentId).toBe("logo@x");
    expect(rec.name).toBe("Logo.PNG");
  });
});
