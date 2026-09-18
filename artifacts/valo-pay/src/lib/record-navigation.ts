/** Keep a queue's filters and lender when an operator follows a record. */
export function collectionReturnTo(search: URLSearchParams, merchantId: string, rowId?: string): string {
  const params = new URLSearchParams(search);
  params.delete('returnTo');
  params.set('lender', merchantId);
  return `/collections?${params}${rowId ? `#record-${encodeURIComponent(rowId)}` : ''}`;
}

/** Return links can only point to this lender's collections queue, never an external site. */
export function safeCollectionReturnTo(value: string | null, merchantId: string | null | undefined): string | null {
  if (!value || !merchantId || value.length > 4096 || !value.startsWith('/collections?') || /[\\\r\n]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://valopay.invalid');
    if (url.origin !== 'https://valopay.invalid' || url.pathname !== '/collections' || url.searchParams.get('lender') !== merchantId) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function recordDestination(path: string, recordId: string, returnTo: string, merchantId: string, parameter = 'record'): string {
  const params = new URLSearchParams({ [parameter]: recordId, lender: merchantId, returnTo });
  return `${path}?${params}#record-${encodeURIComponent(recordId)}`;
}
