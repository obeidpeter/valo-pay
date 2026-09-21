import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "./workspace-context";
import { submissionFingerprint } from "./safe-mutations";

export interface ConnectedRecord {
  id: string;
  name: string;
  reference: string;
  status: string;
  amountKobo: number;
  customerId: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, any>;
  effectiveStatus?: string;
}
export interface ConnectedView {
  mode: "synthetic";
  revision: string;
  asOf: string;
  role: string;
  entity: { id: string; name: string; workspaceOwner: string };
  customers: Array<{ id: string; name: string; reference: string }>;
  consents: ConnectedRecord[];
  purposes: Array<{ id: string; label: string }>;
  gates: Array<{
    id: string;
    name: string;
    requires: string;
    status: string;
    liveEnabled: false;
  }>;
  payments: {
    intents: ConnectedRecord[];
    dues: Array<{
      id: string;
      name: string;
      reference: string;
      customerId: string;
      customerName: string;
      outstandingKobo: number;
      blocked: boolean;
    }>;
  };
  credit: any;
  cash: any;
}
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    signal: options.signal ?? AbortSignal.timeout(25000),
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(body.error || "The request could not be completed."),
      { status: response.status },
    );
  return body;
}
export function useConnected() {
  const { merchantId, workspace } = useWorkspace(),
    client = useQueryClient();
  const scope = `${merchantId ?? ""}:${workspace?.role ?? ""}`;
  const previousScope = useRef(scope);
  const attempt = useRef<{
    fingerprint: string;
    key: string;
    body: string;
  } | null>(null);
  if (previousScope.current !== scope) {
    previousScope.current = scope;
    attempt.current = null;
  }
  const query = useQuery<ConnectedView>({
    queryKey: ["connected", merchantId],
    enabled: !!merchantId,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/connected?merchantId=${encodeURIComponent(merchantId!)}`,
        { signal },
      ),
    staleTime: 10000,
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      action: string;
      data: Record<string, unknown>;
      recordId?: string;
      reason: string;
    }) => {
      if (!merchantId || !query.data)
        throw new Error("Wait for the workspace to load.");
      // A refreshed revision is not a new user intention. Keep the exact first
      // request after a lost/ambiguous response so the server can replay its
      // committed answer even though the workspace now has a newer revision.
      const fingerprint = submissionFingerprint({ scope, input });
      if (!attempt.current || attempt.current.fingerprint !== fingerprint)
        attempt.current = {
          fingerprint,
          key: crypto.randomUUID(),
          body: JSON.stringify({
            ...input,
            expectedRevision: query.data.revision,
          }),
        };
      const current = attempt.current;
      try {
        await request(
          `/api/v1/connected/actions?merchantId=${encodeURIComponent(merchantId)}`,
          {
            method: "POST",
            headers: { "Idempotency-Key": current.key },
            body: current.body,
          },
        );
        if (attempt.current === current) attempt.current = null;
      } catch (error) {
        // A definite request rejection did not commit; a reviewed retry may
        // use the newly fetched revision. Network/timeout/5xx stays ambiguous.
        const status = (error as { status?: number }).status;
        if (
          status &&
          status >= 400 &&
          status < 500 &&
          attempt.current === current
        )
          attempt.current = null;
        throw error;
      }
    },
    onSettled: () => client.invalidateQueries(),
  });
  return {
    ...query,
    run: async (
      action: string,
      data: Record<string, unknown> = {},
      recordId?: string,
      reason = "Explore the synthetic workflow",
    ) => {
      await mutation.mutateAsync({ action, data, recordId, reason });
    },
    pending: mutation.isPending,
    canWrite: !!workspace && workspace.role !== "Read-only",
  };
}
