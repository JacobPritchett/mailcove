import { describe, it, expect, vi } from "vitest";
vi.mock("../auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth")>(),
  verifyAccess: vi.fn(async () => "owner@example.com"),
}));
import { handleFetch, type Env } from "../index";

describe("owner domain-management path", () => {
  it("still rejects cross-origin cookie-authenticated writes", async () => {
    const response = await handleFetch(new Request("https://inbox.example.com/api/domain-routing/z1/catch-all", {
      method: "PUT", headers: { Origin: "https://other.example", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "drop" }),
    }), {} as Env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "bad origin" });
  });

  it("dispatches an authenticated same-origin write to the existing validation", async () => {
    const response = await handleFetch(new Request("https://inbox.example.com/api/domain-routing/z1/catch-all", {
      method: "PUT", headers: { Origin: "https://inbox.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
    }), {} as Env, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid action" });
  });
});
