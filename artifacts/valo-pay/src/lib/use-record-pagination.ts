import { useEffect, useState } from 'react';

export const RECORD_PAGE_SIZES = [25, 50, 100] as const;

/** Wait for a pause in typing; changing lenders never reuses another lender's search. */
export function useDebouncedSearch(value: string, scope: string | null | undefined, delay = 300) {
  const trimmed = value.trim();
  const [settled, setSettled] = useState({ scope, value: trimmed });
  useEffect(() => {
    const timeout = setTimeout(() => setSettled({ scope, value: trimmed }), delay);
    return () => clearTimeout(timeout);
  }, [trimmed, scope, delay]);
  const search = settled.scope === scope ? settled.value : '';
  return { search, searchPending: search !== trimmed };
}

/** Reset synchronously on a lender/filter change, before issuing the next request. */
export function useRecordPagination(resetKey: string, total?: number) {
  const [size, setSize] = useState<number>(25);
  const [position, setPosition] = useState({ key: resetKey, page: 0 });
  useEffect(() => {
    setPosition(previous => previous.key === resetKey ? previous : { key: resetKey, page: 0 });
  }, [resetKey]);
  const requestedPage = position.key === resetKey ? position.page : 0;
  const page = total === undefined ? requestedPage : Math.min(requestedPage, Math.max(0, Math.ceil(total / size) - 1));
  const setPage = (next: number) => setPosition({ key: resetKey, page: Math.max(0, Math.floor(next)) });
  const setPageSize = (next: number) => {
    if (!RECORD_PAGE_SIZES.some(value => value === next)) return;
    setSize(next);
    setPosition({ key: resetKey, page: 0 });
  };
  return { page, pageSize: size, offset: page * size, setPage, setPageSize };
}

export type RecordPaginationState = ReturnType<typeof useRecordPagination>;

/**
 * A list query's placeholder while a person pages: the rows shown stay until the next page arrives, so the table, its
 * pager and the control pressed stay in place. Another lender, search or filter never shows the earlier rows.
 */
export function keepRowsWhilePaging(params: object) {
  const scope = (value: unknown) => JSON.stringify({ ...(value as object), limit: undefined, offset: undefined });
  return <T,>(previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] }): T | undefined =>
    previousQuery && scope(previousQuery.queryKey[1]) === scope(params) ? previous : undefined;
}
