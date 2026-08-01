// Inbound attachment storage sits on the delivery path: the message row is
// inserted after it, so this must be bounded and must never throw.
import { describe, it, expect, vi } from "vitest";
import {
  storeInboundAttachments,
  MAX_INBOUND_ATTACHMENTS,
  type InboundPart,
} from "../attachments";

const rec = (part: InboundPart, i: number) => ({
  partId: `p${i}`,
  name: part.filename || `attachment-${i + 1}`,
  mimeType: part.mimeType || "",
  size: 0,
  disposition: part.disposition || "",
  contentId: null,
});

const parts = (n: number): InboundPart[] =>
  Array.from({ length: n }, (_, i) => ({
    filename: `f${i}.bin`,
    mimeType: "application/octet-stream",
    content: new ArrayBuffer(8),
  }));

describe("storeInboundAttachments", () => {
  it("stores every part of an ordinary message", async () => {
    const put = vi.fn(async (_k: string, _b: unknown, _o: { httpMetadata: { contentType: string } }) => undefined);

    const out = await storeInboundAttachments(put, "msg1", parts(3), rec);

    expect(out.records.map((r) => r.partId)).toEqual(["p0", "p1", "p2"]);
    expect(out.skipped).toBe(0);
    expect(put.mock.calls.map((c) => c[0])).toEqual([
      "att/msg1/p0",
      "att/msg1/p1",
      "att/msg1/p2",
    ]);
  });

  it("passes the part's content type through to storage", async () => {
    const put = vi.fn(async (_k: string, _b: unknown, _o: { httpMetadata: { contentType: string } }) => undefined);
    const one: InboundPart[] = [{ filename: "a.pdf", mimeType: "application/pdf", content: new ArrayBuffer(4) }];

    await storeInboundAttachments(put, "msg1", one, rec);

    expect(put.mock.calls[0][2].httpMetadata.contentType)
      .toBe("application/pdf");
  });

  it("falls back to a binary type when the part declares none", async () => {
    const put = vi.fn(async (_k: string, _b: unknown, _o: { httpMetadata: { contentType: string } }) => undefined);
    const one: InboundPart[] = [{ filename: "a", mimeType: "", content: new ArrayBuffer(4) }];

    await storeInboundAttachments(put, "msg1", one, rec);

    expect(put.mock.calls[0][2].httpMetadata.contentType)
      .toBe("application/octet-stream");
  });

  it("caps how many parts it will ever write", async () => {
    const put = vi.fn(async (_k: string, _b: unknown, _o: { httpMetadata: { contentType: string } }) => undefined);
    const many = parts(MAX_INBOUND_ATTACHMENTS + 25);

    const out = await storeInboundAttachments(put, "msg1", many, rec);

    // Without a cap, one crafted message becomes thousands of sequential object
    // writes on the delivery path.
    expect(put).toHaveBeenCalledTimes(MAX_INBOUND_ATTACHMENTS);
    expect(out.records.filter((r) => r.stored)).toHaveLength(MAX_INBOUND_ATTACHMENTS);
    expect(out.skipped).toBe(25);
  });

  it("does not throw when a write fails, and counts it", async () => {
    const put = vi.fn(async (key: string, _b: unknown, _o: { httpMetadata: { contentType: string } }) => {
      if (key.endsWith("p1")) throw new Error("R2 unavailable");
      return undefined;
    });

    const out = await storeInboundAttachments(put, "msg1", parts(3), rec);

    // Throwing would abort ingest before the message row is written, leaving
    // mail in R2 that never appears in the inbox.
    expect(out.skipped).toBe(1);
    expect(out.records).toHaveLength(3);
  });

  it("survives every write failing", async () => {
    const put = vi.fn(async () => {
      throw new Error("R2 down");
    });

    const out = await storeInboundAttachments(put, "msg1", parts(4), rec);

    expect(out.skipped).toBe(4);
    expect(out.records).toHaveLength(4);
  });

  it("handles a message with no attachments", async () => {
    const put = vi.fn(async () => undefined);

    const out = await storeInboundAttachments(put, "msg1", [], rec);

    expect(out).toEqual({ records: [], skipped: 0 });
    expect(put).not.toHaveBeenCalled();
  });

  it("pairs every record with ITS OWN bytes, across chunk boundaries", async () => {
    // The chunking indexes `capped[i + n]` while mapping over a slice. Getting
    // that wrong serves attachment 7's download as attachment 1's bytes, under
    // the right name and size, which is the worst failure mode available here.
    // Key-only assertions cannot see it.
    const n = 14; // > 2 chunks of 6
    const tagged: InboundPart[] = Array.from({ length: n }, (_, i) => ({
      filename: `f${i}.bin`,
      mimeType: "application/octet-stream",
      content: new Uint8Array([i]).buffer,
    }));
    const seen = new Map<string, number>();
    const put = vi.fn(async (key: string, body: unknown) => {
      seen.set(key, new Uint8Array(body as ArrayBuffer)[0]);
      return undefined;
    });

    await storeInboundAttachments(put, "msg1", tagged, rec);

    for (let i = 0; i < n; i++) {
      expect(seen.get(`att/msg1/p${i}`)).toBe(i);
    }
  });

  it("marks records whose bytes were not stored", async () => {
    const put = vi.fn(async (key: string) => {
      if (key.endsWith("p1")) throw new Error("R2 unavailable");
      return undefined;
    });

    const out = await storeInboundAttachments(put, "msg1", parts(3), rec);

    // A record that looks complete but 404s on click is worse than one that
    // says plainly it is not there.
    expect(out.records.map((r) => r.stored)).toEqual([true, false, true]);
  });

  it("still records parts past the write cap, marked unstored", async () => {
    const put = vi.fn(async () => undefined);

    const out = await storeInboundAttachments(put, "msg1", parts(MAX_INBOUND_ATTACHMENTS + 5), rec);

    // Dropping them outright made a 55-attachment message render as a tidy
    // 50-attachment one with nothing to say five were missing.
    expect(out.records).toHaveLength(MAX_INBOUND_ATTACHMENTS + 5);
    expect(out.records.filter((r) => r.stored)).toHaveLength(MAX_INBOUND_ATTACHMENTS);
    expect(out.skipped).toBe(5);
  });

  it("counts a synchronously throwing put instead of aborting", async () => {
    // allSettled only converts rejections of promises it RECEIVES. A throw
    // raised while calling put escapes map() entirely unless the callback is
    // async, taking down ingest with it.
    const put = vi.fn(() => {
      throw new TypeError("bad body type");
    }) as unknown as (k: string, b: unknown, o: { httpMetadata: { contentType: string } }) => Promise<unknown>;

    const out = await storeInboundAttachments(put, "msg1", parts(2), rec);

    expect(out.skipped).toBe(2);
    expect(out.records.every((r) => !r.stored)).toBe(true);
  });

  it("does not issue all writes at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const put = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });

    await storeInboundAttachments(put, "msg1", parts(30), rec);

    // Concurrent, but bounded: sequential would be slow, unbounded would open
    // 30 connections at once.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });
});
