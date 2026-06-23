// AI auto-label categories — display metadata for chips + the inbox filter bar.
// Mirrors the backend set in src/categorize.ts / src/store_views.ts.

export const CATEGORIES = ["primary", "promotions", "updates", "social"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CategoryMeta {
  label: string;
  /** Tailwind classes for the row chip (light + dark). */
  chip: string;
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  primary: { label: "Primary", chip: "" },
  promotions: {
    label: "Promotions",
    chip: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  },
  updates: {
    label: "Updates",
    chip: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  },
  social: {
    label: "Social",
    chip: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
  },
};

/** Normalize a stored category (which may be null/unknown) to a Category. */
export function categoryOf(raw: string | null | undefined): Category {
  return raw === "promotions" || raw === "updates" || raw === "social" ? raw : "primary";
}

/** The filter-bar options: "All" first, then each category. `null` = All. */
export const CATEGORY_FILTERS: { value: Category | null; label: string }[] = [
  { value: null, label: "All" },
  ...CATEGORIES.map((c) => ({ value: c as Category | null, label: CATEGORY_META[c].label })),
];
