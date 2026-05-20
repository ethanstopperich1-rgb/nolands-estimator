import type { MetadataRoute } from "next";

/**
 * Next.js native sitemap. Auto-served at `/sitemap.xml`.
 *
 * Only customer-facing routes — staff routes (/dashboard, /internal,
 * /login) are gated by middleware and excluded from robots.txt; no
 * point indexing what crawlers can't reach.
 *
 * Add new public routes here as they ship. The list is intentionally
 * short — every entry is a real top-level customer surface.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base =
    process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://estimate.nolandsroofing.com";
  const now = new Date();

  return [
    {
      url: base,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${base}/privacy`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${base}/terms`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
