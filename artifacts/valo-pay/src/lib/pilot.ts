import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "./workspace-context";
import { useSafeMutation } from "./safe-mutations";
import { CreateRecordResponse } from "@workspace/api-zod";
import { workReceiptSchema, lifecycleRunViewSchema, lifecycleViewSchema, importCorrectionViewSchema } from '@workspace/valopay-schema';
import { z } from 'zod';
export async function pilotRequest<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...options,
    signal: options.signal || AbortSignal.timeout(25000),
    headers: new Headers({
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(options.headers)),
    }),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || "The request could not be completed."),
      { status: response.status, data },
    );
  if (!data || typeof data !== "object")
    throw new Error(
      "The service returned an incomplete confirmation. Check Operations before submitting again.",
    );
  return data as T;
}
export function lenderPath(
  path: string,
  merchantId: string | null,
  offset?: number,
) {
  return `${path}${path.includes("?") ? "&" : "?"}merchantId=${encodeURIComponent(merchantId || "")}${offset ? `&offset=${offset}` : ""}`;
}
export function usePilotQuery<T = any>(path: string, lender = true) {
  const { merchantId, workspace } = useWorkspace();
  return useQuery<T>({
    queryKey: ["pilot", workspace?.actor, merchantId, path],
    enabled: Boolean(workspace) && (!lender || !!merchantId),
    queryFn: ({ signal }) =>
      pilotRequest(lender ? lenderPath(path, merchantId) : path, { signal }),
  });
}
export function usePilotMutation(onSuccess?: (data: any) => void) {
  const { merchantId, workspace } = useWorkspace(),
    cache = useQueryClient();
  return useSafeMutation(
    async (
      v: {
        path: string;
        data?: unknown;
        method?: "POST" | "PATCH";
        lender?: boolean;
      },
      options,
    ) => {
      const result = await pilotRequest(
        v.lender === false ? v.path : lenderPath(v.path, merchantId),
        {
          ...options,
          method: v.method || "POST",
          body: JSON.stringify(v.data || {}),
        },
      );
      const expectedKind = /^\/pilot\/close-reviews\//.test(v.path) ? 'close-reviews' : /^\/sources\/profiles(?:\/|$)/.test(v.path) ? 'source-profiles' : v.path === '/sources/manifests' ? 'source-manifests' : undefined;
      if(expectedKind && (!CreateRecordResponse.safeParse(result).success || result.kind !== expectedKind || result.merchantId !== merchantId || !result.id))throw new Error('The service returned an incomplete confirmation. Check Operations before submitting again.');
      if(/^\/pilot\/import-corrections(?:\/[^/]+\/decision)?$/.test(v.path)) {
        const receipt = importCorrectionViewSchema.parse(result), input = v.data as { batchId?: string; targetId?: string; proposalDigest?: string };
        if(receipt.merchantId !== merchantId || (input?.batchId && receipt.preview.batchId !== input.batchId) || (input?.targetId && receipt.preview.targetId !== input.targetId) || (input?.proposalDigest && receipt.proposalDigest !== input.proposalDigest)) throw new Error('The correction confirmation does not match this lender or request. Check Operations before submitting again.');
      }
      if(v.path.startsWith('/work/')) {const receipt=workReceiptSchema.parse(result);if(receipt.merchantId!==merchantId||receipt.actor!==workspace?.actor)throw new Error('The confirmation belongs to another workspace. Refresh Operations.');}
      if(v.path.startsWith('/lifecycle/')){const receipt=v.path.startsWith('/lifecycle/runs')?lifecycleRunViewSchema.parse(result):lifecycleViewSchema.parse(result);if(receipt.merchantId!==merchantId)throw new Error('The retention confirmation belongs to another lender. Refresh Operations.');}
      if(v.path==='/sources/paystack/fixtures') z.object({accepted:z.boolean(),duplicate:z.boolean(),event:z.object({id:z.string().min(1),mode:z.literal('fixture'),financialRecordsCreated:z.literal(0)})}).parse(result);
      if(/^\/sources\/events\//.test(v.path))z.object({id:z.string().min(1),mode:z.enum(['fixture','test']),financialRecordsCreated:z.literal(0)}).parse(result);
      if (
        /^\/pilot\/(batches|cases)/.test(v.path) &&
        (!CreateRecordResponse.safeParse(result).success ||
          result.merchantId !== merchantId ||
          !result.id ||
          (v.path.includes("/batches")
            ? result.kind !== "import-batches"
            : result.kind !== "exceptions"))
      )
        throw new Error(
          "The service returned an incomplete confirmation. Check Operations before submitting again.",
        );
      return result;
    },
    {
      mutation: {
        onSuccess: (data) => {
          void cache.invalidateQueries();
          onSuccess?.(data);
        },
      },
    },
    `${merchantId}:${workspace?.actor}:${workspace?.role}`,
  );
}
