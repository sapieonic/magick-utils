/** A slot in a page control: a page to jump to, or a gap standing for the pages
 *  between its neighbours. */
export type PageSlot = number | "gap";

/** Pages always shown around the current one, on each side. */
const NEIGHBOURS = 1;

/** The widest the control ever gets: first, last, the current page, a neighbour
 *  each side, and a gap each side. Anything more and it stops fitting the card
 *  on a narrow screen, which is the whole problem this solves. */
const MAX_SLOTS = 2 * NEIGHBOURS + 5;

/**
 * The page numbers a pager should show, windowed around `page`.
 *
 * Rendering one button per page is fine while a list has a handful of them and
 * breaks completely once it does not: the row runs past the edge of its card
 * with no scroll, so the hidden numbers cannot be reached at all. Since the
 * campaigns listing stopped truncating at the upstream's first page, an account
 * can reach several hundred pages, so the control has to stay a fixed width no
 * matter how many there are.
 *
 * The first and last pages are always present, so the ends of the list are
 * always one click away. A gap is only ever emitted for two or more pages —
 * replacing a single hidden page with an ellipsis would be both wider and less
 * useful than the number itself.
 */
export function pageSlots(page: number, pages: number): PageSlot[] {
  // `|| 1` catches NaN and 0; Infinity survives both and would hang the loop
  // below forever, so it is screened explicitly rather than implicitly.
  const total = Number.isFinite(pages) ? Math.max(1, Math.floor(pages) || 1) : 1;
  const current = Number.isFinite(page) ? Math.min(total, Math.max(1, Math.floor(page) || 1)) : 1;
  if (total <= MAX_SLOTS) return Array.from({ length: total }, (_, i) => i + 1);

  // Keep the window the same width at the ends of the range, where it would
  // otherwise be clipped by the first/last page and the control would visibly
  // shrink as you paged towards either end.
  const windowSize = 2 * NEIGHBOURS + 1;
  let start = Math.max(2, current - NEIGHBOURS);
  let end = Math.min(total - 1, current + NEIGHBOURS);
  if (current - NEIGHBOURS < 2) end = Math.min(total - 1, windowSize + 1);
  if (current + NEIGHBOURS > total - 1) start = Math.max(2, total - windowSize);

  const slots: PageSlot[] = [1];
  // A gap hiding exactly one page is wider than the page it hides and cannot be
  // clicked, so show that page instead. Same slot count either way.
  if (start > 3) slots.push("gap");
  else if (start === 3) slots.push(2);
  for (let i = start; i <= end; i += 1) slots.push(i);
  if (end < total - 2) slots.push("gap");
  else if (end === total - 2) slots.push(total - 1);
  slots.push(total);
  return slots;
}
