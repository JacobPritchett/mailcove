import { describe, it, expect } from "vitest";
import { categoryOf, CATEGORY_META, CATEGORY_FILTERS, CATEGORIES } from "@/lib/categories";

describe("categoryOf", () => {
  it("passes through the three labelled categories", () => {
    expect(categoryOf("promotions")).toBe("promotions");
    expect(categoryOf("updates")).toBe("updates");
    expect(categoryOf("social")).toBe("social");
  });
  it("maps null / unknown / 'primary' to primary", () => {
    expect(categoryOf(null)).toBe("primary");
    expect(categoryOf(undefined)).toBe("primary");
    expect(categoryOf("primary")).toBe("primary");
    expect(categoryOf("bogus")).toBe("primary");
  });
});

describe("category metadata", () => {
  it("has display meta for every category; primary has no chip styling", () => {
    for (const c of CATEGORIES) expect(CATEGORY_META[c].label.length).toBeGreaterThan(0);
    expect(CATEGORY_META.primary.chip).toBe("");
    expect(CATEGORY_META.promotions.chip).not.toBe("");
  });
  it("filter bar leads with All (null) then every category", () => {
    expect(CATEGORY_FILTERS[0]).toEqual({ value: null, label: "All" });
    expect(CATEGORY_FILTERS.map((f) => f.value)).toEqual([null, "primary", "promotions", "updates", "social"]);
  });
});
