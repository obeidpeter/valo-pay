import { useSearchParams, useLocation } from "wouter";
import { RECORD_PAGE_SIZES } from "./use-record-pagination";
/** URLs carry page state through history and record visits. A lender change
 * never reuses the previous lender's page. Filter controls clear their page. */
export function useUrlPagination(
  merchantId: string | null | undefined,
  prefix = "",
) {
  const [search] = useSearchParams();
  const [, navigate] = useLocation();
  const pageKey = prefix + "page",
    sizeKey = prefix + "size";
  const size = Number(search.get(sizeKey) || 25),
    pageSize = RECORD_PAGE_SIZES.some((n) => n === size) ? size : 25;
  const number = Number(search.get(pageKey) || 1);
  const page =
    search.get("lender") && search.get("lender") !== merchantId
      ? 0
      : Number.isSafeInteger(number) && number > 0 && number <= 21474836
        ? number - 1
        : 0;
  const update = (next: number, nextSize = pageSize) => {
    const params = new URLSearchParams(search);
    params.set(pageKey, String(Math.max(0, Math.floor(next)) + 1));
    params.set(sizeKey, String(nextSize));
    if (merchantId) params.set("lender", merchantId);
    navigate(window.location.pathname + "?" + params + window.location.hash);
  };
  return {
    page,
    pageSize,
    offset: page * pageSize,
    setPage: (next: number) => update(next),
    setPageSize: (next: number) => {
      if (RECORD_PAGE_SIZES.some((n) => n === next)) update(0, next);
    },
  };
}
