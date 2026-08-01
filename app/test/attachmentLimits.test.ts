import { describe, it, expect } from "vitest";
import {
  checkAttachmentLimits,
  formatBytes,
  MAX_ATTACHMENTS,
  type StagedAttachment,
} from "@/lib/attachments";

const staged = (size: number, name = "a.txt"): StagedAttachment => ({
  name,
  type: "text/plain",
  size,
  data: "",
});
const file = (size: number, name = "f.bin") => ({ name, size }) as File;

describe("formatBytes", () => {
  it("scales the unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("checkAttachmentLimits", () => {
  it("allows an ordinary selection", () => {
    expect(checkAttachmentLimits([], [file(1024)])).toBeNull();
  });

  it("counts existing attachments toward the file-count cap", () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS }, () => staged(10));
    expect(checkAttachmentLimits(existing, [file(10)])).toMatch(/up to 10 files/);
  });

  it("names the specific file that is too big", () => {
    const msg = checkAttachmentLimits([], [file(1024), file(6 * 1024 * 1024, "huge.bin")]);
    // A generic "too large" leaves the user guessing which one to drop.
    expect(msg).toMatch(/huge\.bin/);
  });

  it("rejects a total that only exceeds the cap once combined", () => {
    // Each file passes the per-file cap; together they do not.
    const existing = [staged(4 * 1024 * 1024)];
    const msg = checkAttachmentLimits(existing, [file(4 * 1024 * 1024), file(4 * 1024 * 1024)]);
    expect(msg).toMatch(/total more than/);
  });

  it("allows a selection that exactly meets the caps", () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS - 1 }, () => staged(1));
    expect(checkAttachmentLimits(existing, [file(5 * 1024 * 1024)])).toBeNull();
  });
});
