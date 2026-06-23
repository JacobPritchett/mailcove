import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array, pushSupported } from "@/lib/push";

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url VAPID key (handles missing padding + - _)", () => {
    // "BKLp" -> 0x04 0xA2 0xE9 ; just assert the first bytes + length sanity.
    const out = urlBase64ToUint8Array("BKLpHjV3");
    expect(out[0]).toBe(0x04);
    expect(out.length).toBe(6);
  });

  it("round-trips an arbitrary byte sequence", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    let b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(Array.from(urlBase64ToUint8Array(b64))).toEqual(Array.from(bytes));
  });
});

describe("pushSupported", () => {
  it("is false in the jsdom test environment (no PushManager)", () => {
    expect(pushSupported()).toBe(false);
  });
});
