import type { MetadataRoute } from "next";

// The template pages are for search engines; the API (package downloads,
// preview images, JSON) is not – crawlers following the download links
// would otherwise show up in the download counts.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
  };
}
