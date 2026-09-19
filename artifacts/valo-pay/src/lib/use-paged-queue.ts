import { useEffect, useState } from 'react';
import { useListQueue, getListQueueQueryKey, type ListQueueParams } from '@workspace/api-client-react';
import { useWorkspace } from './workspace-context';
import { useRecordPagination } from './use-record-pagination';
import { useQueryClient } from '@tanstack/react-query';

/** Query keys include the complete lender/filter/page scope. Never display a previous scope's rows. */
export function usePagedQueue(queue: 'exceptions' | 'mandates' | 'collections', filters: Omit<ListQueueParams, 'merchantId' | 'limit' | 'offset'>) {
  const { merchantId } = useWorkspace();
  const client = useQueryClient();
  const scope = JSON.stringify([merchantId, queue, filters]);
  const pagination = useRecordPagination(scope);
  const [located, setLocated] = useState('');
  const target = located === scope ? undefined : filters.target;
  const params = { ...filters, target, merchantId: merchantId!, limit: pagination.pageSize, offset: pagination.offset };
  const query = useListQueue(queue, params, { query: { enabled: !!merchantId, queryKey: getListQueueQueryKey(queue, params) } });
  useEffect(() => {
    if (!query.data) return;
    if (target) {
      // Keep the resolved page mounted when switching to ordinary pagination.
      // A second empty loading state would detach the deep-link focus target.
      client.setQueryData(getListQueueQueryKey(queue, { ...params, target: undefined, offset: query.data.offset }), query.data);
      setLocated(scope);
    }
    const actualPage = Math.floor(query.data.offset / pagination.pageSize);
    if (actualPage !== pagination.page) pagination.setPage(actualPage);
  }, [query.data, scope, target, pagination.pageSize, pagination.page]);
  return { ...query, pagination: { ...pagination, ...(query.data ? { offset: query.data.offset, page: Math.floor(query.data.offset / pagination.pageSize) } : {}) } };
}
