import type { SearchResultItem } from "@/api/types"

export interface SearchHitDisplay {
  /** `Image`, `PDF p.3`, or null for a hit without a chip. */
  chip: string | null
  /** True when the hit is an image file, which shows a thumbnail. */
  thumbnail: boolean
}

/** How the search modal marks a semantic hit. Only PDF chunks carry a page. */
export function searchHitDisplay(hit: Pick<SearchResultItem, "kind" | "page">): SearchHitDisplay {
  if (hit.page != null) return { chip: `PDF p.${hit.page}`, thumbnail: false }
  if (hit.kind === "image") return { chip: "Image", thumbnail: true }
  return { chip: null, thumbnail: false }
}
