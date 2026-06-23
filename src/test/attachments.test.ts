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
});
