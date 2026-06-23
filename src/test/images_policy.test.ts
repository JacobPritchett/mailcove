import { describe, it, expect } from "vitest";
import { messageImagePolicy } from "../index";

describe("messageImagePolicy", () => {
  it("shows remote when allowlisted AND dmarc_pass", () => {
    expect(messageImagePolicy({ allowed: true, dmarcPass: 1 })).toBe(true);
  });
  it("blocks when allowlisted but dmarc fails (spoof protection)", () => {
    expect(messageImagePolicy({ allowed: true, dmarcPass: 0 })).toBe(false);
  });
  it("blocks when not allowlisted", () => {
    expect(messageImagePolicy({ allowed: false, dmarcPass: 1 })).toBe(false);
  });
});
