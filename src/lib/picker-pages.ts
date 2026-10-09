export type PickerPage = number | "ellipsis-left" | "ellipsis-right";

/**
 * Page numbers around the current page, with ellipses hiding the long tails.
 * Short lists render in full; longer ones collapse to first/previous/current/
 * next/last so the control never wraps.
 */
export function buildPickerPages(currentPage: number, totalPages: number): PickerPage[] {
  if (totalPages <= 7) return Array.from({ length: Math.max(0, totalPages) }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, currentPage]);
  for (let offset = 1; offset <= 2; offset++) {
    if (currentPage - offset >= 1) pages.add(currentPage - offset);
    if (currentPage + offset <= totalPages) pages.add(currentPage + offset);
  }
  const sorted = [...pages].sort((left, right) => left - right);
  const out: PickerPage[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) out.push(page < currentPage ? "ellipsis-left" : "ellipsis-right");
    out.push(page);
    previous = page;
  }
  return out;
}