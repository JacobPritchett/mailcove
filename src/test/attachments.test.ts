import { describe, it, expect } from "vitest";
import { serveAttachment } from "../index";

describe("serveAttachment", () => {
  it("forces a stored text/html attachment to download with nosniff (no inline html)", () => {
    const res = serveAttachment("<h1>hi</h1>", "text/html", "evil.html");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Type")).not.toBe("text/html");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain('filename="evil.html"');
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("serves an allowlisted image inline with nosniff", () => {
    const res = serveAttachment(new Uint8Array([1, 2, 3]), "image/png", "photo.png");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("forces a PDF to download (no longer inline — parser attack surface)", () => {
    const res = serveAttachment(new Uint8Array([1]), "application/pdf", "doc.pdf");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Type")).not.toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain('filename="doc.pdf"');
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("forces an SVG to download (octet-stream, attachment, nosniff — not inline)", () => {
    const res = serveAttachment("<svg onload=alert(1)></svg>", "image/svg+xml", "x.svg");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Type")).not.toBe("image/svg+xml");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain('filename="x.svg"');
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("forces unknown types to download", () => {
    const res = serveAttachment(new Uint8Array([1]), "application/zip", "a.zip");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  // A header value must be ASCII. A raw non-ASCII filename is an invalid header:
  // some proxies reject the response outright and browsers guess at the bytes.
  it("keeps the header ASCII and carries a non-ASCII filename in filename*", () => {
    const res = serveAttachment(new Uint8Array([1]), "application/zip", "\u0444\u043e\u0442\u043e \u0438 docs.zip");
    const cd = res.headers.get("Content-Disposition")!;
    expect(/^[\x20-\x7e]+$/.test(cd)).toBe(true);
    expect(cd).toContain('filename="____ _ docs.zip"');
    expect(cd).toContain("filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE%20%D0%B8%20docs.zip");
  });

  it("does not add filename* for a plain ASCII name, and neutralises header breakers", () => {
    const res = serveAttachment(new Uint8Array([1]), "application/zip", 'a"b\\c\r\nX: y.zip');
    const cd = res.headers.get("Content-Disposition")!;
    expect(cd).toBe('attachment; filename="a_b_c__X: y.zip"');
  });
});
