import { describe, it, expect } from "vitest";
import {
  sanitizeAttachmentFilename,
  sanitizeMimeType,
  decodeBase64,
  parseOutboundAttachments,
  AttachmentError,
  MAX_ATTACHMENTS,
} from "../attachments";

const b64 = (s: string) => btoa(s);

describe("sanitizeAttachmentFilename", () => {
  it("keeps an ordinary name intact", () => {
    expect(sanitizeAttachmentFilename("quarterly report.pdf")).toBe("quarterly report.pdf");
  });

  it("strips CR/LF so a name cannot inject a header", () => {
    // The name lands in Content-Disposition; a bare CRLF would end that header
    // and let whatever follows be read as a new one.
    const out = sanitizeAttachmentFilename("invoice.pdf\r\nBcc: attacker@evil.example");
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe("invoice.pdf Bcc: attacker@evil.example");
  });

  it("strips other control characters including NUL", () => {
    expect(sanitizeAttachmentFilename("a\u0000b\u0001c\u007fd")).toBe("a b c d");
  });

  it("removes quotes that would break the quoted string", () => {
    expect(sanitizeAttachmentFilename('re"port.pdf')).toBe("report.pdf");
  });

  it("flattens BOTH separators, not just forward slash", () => {
    // The quote pass used to delete backslashes before the separator pass ran,
    // so this direction was silently unhandled.
    expect(sanitizeAttachmentFilename("..\\..\\windows\\system32\\evil.exe"))
      .toBe("-..-windows-system32-evil.exe");
  });

  it("strips bidi overrides that let a name lie about its extension", () => {
    // "invoice<RLO>fdp.exe" renders to a reader as "invoiceexe.pdf".
    const out = sanitizeAttachmentFilename("invoice\u202Efdp.exe");
    expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(out).toBe("invoice fdp.exe");
  });

  it("strips zero-width and C1 control characters", () => {
    expect(sanitizeAttachmentFilename("a\u200bb\u0085c\ufeffd")).toBe("a b c d");
  });

  it("keeps the extension when truncating a very long name", () => {
    const long = "y".repeat(250) + ".pdf";
    const out = sanitizeAttachmentFilename(long);
    expect(out).toHaveLength(200);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("never truncates through a surrogate pair", () => {
    const out = sanitizeAttachmentFilename("z".repeat(199) + "\u{1F600}");
    // A lone surrogate is malformed and would mojibake in the header. Checked
    // by code unit rather than String.isWellFormed, which needs a newer lib.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(out)).toBe(false);
  });

  it("flattens path separators so a name never reads as a path", () => {
    expect(sanitizeAttachmentFilename("../../etc/passwd")).not.toContain("/");
    expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe("-..-etc-passwd");
  });

  it("never returns an empty name", () => {
    expect(sanitizeAttachmentFilename("")).toBe("attachment");
    expect(sanitizeAttachmentFilename("\r\n")).toBe("attachment");
    expect(sanitizeAttachmentFilename(null)).toBe("attachment");
  });

  it("caps absurd lengths", () => {
    expect(sanitizeAttachmentFilename("x".repeat(500))).toHaveLength(200);
  });
});

describe("sanitizeMimeType", () => {
  it("accepts a well-formed type and normalizes case", () => {
    expect(sanitizeMimeType("application/pdf")).toBe("application/pdf");
    expect(sanitizeMimeType("IMAGE/PNG")).toBe("image/png");
  });

  it("rejects parameters or embedded newlines", () => {
    expect(sanitizeMimeType("text/html; charset=utf-8")).toBe("application/octet-stream");
    expect(sanitizeMimeType("text/html\r\nX: y")).toBe("application/octet-stream");
  });

  it("falls back for junk", () => {
    expect(sanitizeMimeType("")).toBe("application/octet-stream");
    expect(sanitizeMimeType("nope")).toBe("application/octet-stream");
    expect(sanitizeMimeType(undefined)).toBe("application/octet-stream");
  });
});

describe("decodeBase64", () => {
  it("round-trips content", () => {
    expect(new TextDecoder().decode(decodeBase64(b64("hello world")))).toBe("hello world");
  });

  it("accepts a data: URL as produced by FileReader", () => {
    const decoded = decodeBase64(`data:application/pdf;base64,${b64("pdf bytes")}`);
    expect(new TextDecoder().decode(decoded)).toBe("pdf bytes");
  });

  it("tolerates embedded whitespace", () => {
    const withWs = b64("hello world").replace(/(.{4})/g, "$1\n");
    expect(new TextDecoder().decode(decodeBase64(withWs))).toBe("hello world");
  });

  it("rejects non-base64 rather than silently producing bytes", () => {
    expect(() => decodeBase64("not base64!!")).toThrow(AttachmentError);
    expect(() => decodeBase64("aGVsbG8")).toThrow(AttachmentError); // length not a multiple of 4
    expect(() => decodeBase64("")).toThrow(AttachmentError);
  });

  it("preserves binary bytes exactly", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(Array.from(decodeBase64(btoa(bin)))).toEqual([0, 1, 250, 255, 128]);
  });
});

describe("parseOutboundAttachments", () => {
  const one = (over: Record<string, unknown> = {}) => ({
    filename: "a.txt",
    type: "text/plain",
    data: b64("hi"),
    ...over,
  });

  it("returns [] when absent", () => {
    expect(parseOutboundAttachments(undefined)).toEqual([]);
    expect(parseOutboundAttachments(null)).toEqual([]);
  });

  it("decodes and sanitizes each entry", () => {
    const out = parseOutboundAttachments([one({ filename: "x\r\ny.txt", type: "junk" })]);
    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe("x y.txt");
    expect(out[0].type).toBe("application/octet-stream");
    expect(new TextDecoder().decode(out[0].content)).toBe("hi");
  });

  it("rejects a non-array", () => {
    expect(() => parseOutboundAttachments("nope")).toThrow(/must be an array/);
    expect(() => parseOutboundAttachments({})).toThrow(/must be an array/);
  });

  it("rejects non-object entries", () => {
    expect(() => parseOutboundAttachments(["file"])).toThrow(/must be an object/);
    expect(() => parseOutboundAttachments([null])).toThrow(/must be an object/);
  });

  it("enforces the count cap", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => one());
    expect(() => parseOutboundAttachments(many)).toThrow(/too many attachments/);
  });

  it("enforces the per-file size cap", () => {
    const big = btoa("A".repeat(6 * 1024 * 1024)); // 6 MB, over the 5 MB per-file cap
    expect(() => parseOutboundAttachments([one({ data: big })])).toThrow(/max 5 MB each/);
  });

  it("enforces the total cap across files that each pass individually", () => {
    const chunk = btoa("A".repeat(4 * 1024 * 1024)); // 3 x 4 MB = 12 MB > 10 MB
    const three = Array.from({ length: 3 }, () => one({ data: chunk }));
    expect(() => parseOutboundAttachments(three)).toThrow(/max 10 MB total/);
  });

  it("makes duplicate filenames distinct", () => {
    // The download route finds an attachment by name, so two files sharing one
    // would both resolve to the first file's bytes.
    const out = parseOutboundAttachments([
      one({ filename: "report.pdf" }),
      one({ filename: "report.pdf" }),
      one({ filename: "REPORT.PDF" }),
      one({ filename: "notes" }),
      one({ filename: "notes" }),
    ]);
    expect(out.map((a) => a.filename)).toEqual([
      "report.pdf",
      "report (2).pdf",
      "REPORT (3).PDF",
      "notes",
      "notes (2)",
    ]);
  });

  it("rejects the whole request when any entry is corrupt", () => {
    // Partial success would send a message silently missing a file the user
    // believes they attached.
    expect(() => parseOutboundAttachments([one(), one({ data: "!!!" })])).toThrow(AttachmentError);
  });
});
