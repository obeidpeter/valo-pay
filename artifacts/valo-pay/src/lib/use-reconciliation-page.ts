import { useSearch } from 'wouter';
import { useEffect } from "react";
import {
  useListReconciliation,
  getListReconciliationQueryKey,
  listReconciliation,
} from "@workspace/api-client-react";
import { useWorkspace } from "./workspace-context";
import { useUrlPagination } from "./use-url-pagination";
export function useReconciliationPage(
  queue: Parameters<typeof listReconciliation>[0],
  dueItem?: string,
) {
  const { merchantId } = useWorkspace();
  const pagination = useUrlPagination(merchantId, queue + "-");
  const q = new URLSearchParams(useSearch()).get('q') || undefined;
  const params = {
    q,
    merchantId: merchantId!,
    dueItem,
    limit: pagination.pageSize,
    offset: pagination.offset,
  };
  const query = useListReconciliation(queue, params, {
    query: {
      enabled: !!merchantId,
      queryKey: getListReconciliationQueryKey(queue, params),
    },
  });
  useEffect(() => {
    if (query.data && query.data.offset !== pagination.offset)
      pagination.correctPage(Math.floor(query.data.offset / pagination.pageSize));
  }, [query.data, pagination.offset, pagination.pageSize]);
  return { ...query, pagination };
}
