import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { lenderPath, pilotRequest, usePilotMutation } from "@/lib/pilot";
import {
  PilotError,
  PilotHeading,
  RecoveryNotice,
} from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/formatters";

export default function OperationsPage() {
  const { merchantId, workspace } = useWorkspace(),
    [offset, setOffset] = useState(0),
    [message, setMessage] = useState("");
  useEffect(() => {
    setOffset(0);
    setMessage("");
  }, [merchantId, workspace?.actor]);
  const list = useQuery<any>({
    queryKey: ["pilot", "operations", workspace?.actor, merchantId, offset],
    enabled: !!merchantId,
    refetchInterval: 15000,
    queryFn: ({ signal }) =>
      pilotRequest(lenderPath("/operations", merchantId, offset), { signal }),
  });
  const action = usePilotMutation((result) => {
    setMessage(
      result.message ||
        "The original request has completed. Its records have been refreshed.",
    );
  });
  return (
    <div className="space-y-6">
      <PilotHeading title="Operations">
        Your requests for this lender, saved on the server. Reopening a request
        uses its original data and request key. A pending result is not proof
        that a payment failed.
      </PilotHeading>
      <div className="rounded-xl border bg-secondary/20 p-4 text-sm">
        History follows your signed-in account or this anonymous sandbox. Sign
        in to the same account to return to its history. Requests that never
        reached the service will not appear here.
      </div>
      <PilotError
        error={list.error}
        retry={() => {
          void list.refetch();
        }}
      />
      <RecoveryNotice mutation={action} />
      <p role="status" className="text-sm">
        {message || (list.isLoading ? "Loading saved operations…" : "")}
      </p>
      <div className="space-y-3">
        {list.data?.items.map((item: any) => (
          <article
            key={item.id}
            className="flex flex-col justify-between gap-4 rounded-xl border bg-card p-5 sm:flex-row"
          >
            <div className="min-w-0 space-y-2">
              <h2 className="font-semibold capitalize">{item.label}</h2>
              <p className="text-sm text-muted-foreground">{item.message}</p>
              {item.status === "completed" &&
                item.recordId &&
                [
                  "customers",
                  "exceptions",
                  "import-batches",
                  "closes",
                ].includes(item.recordKind) && (
                  <Link
                    className="inline-block text-sm text-primary underline"
                    href={
                      item.recordKind === "customers"
                        ? `/customers/${item.recordId}`
                        : item.recordKind === "exceptions"
                          ? `/cases/${item.recordId}`
                          : item.recordKind === "closes"
                            ? "/reports"
                            : "/imports"
                    }
                  >
                    Open saved result
                  </Link>
                )}
              <p className="text-xs text-muted-foreground">
                {formatDate(item.createdAt)} · {item.role}
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                Request {item.id.slice(0, 12)}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold capitalize">
                {item.status}
              </span>
              {item.status === "pending" && (
                <>
                  <Button
                    busy={
                      action.isPending &&
                      action.variables?.path.includes(item.id)
                    }
                    disabled={action.isPending || workspace?.role !== item.role}
                    onClick={() => {
                      setMessage("");
                      action.mutate({ path: `/operations/${item.id}/retry` });
                    }}
                  >
                    Check original request
                  </Button>
                  <Button
                    variant="outline"
                    disabled={action.isPending || workspace?.role !== item.role}
                    onClick={() => {
                      setMessage("");
                      action.mutate({ path: `/operations/${item.id}/cancel` });
                    }}
                  >
                    Cancel if unfinished
                  </Button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {list.data?.total === 0 && (
        <p className="rounded-xl border bg-card p-8 text-sm text-muted-foreground">
          No received requests yet. Saved imports, case changes, reconciliation
          and evidence requests will appear here.
        </p>
      )}
      {list.data?.total > 25 && (
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            disabled={!offset || list.isFetching}
            onClick={() => setOffset((n) => Math.max(0, n - 25))}
          >
            Previous
          </Button>
          <span className="text-sm">
            {offset + 1}–{Math.min(offset + 25, list.data.total)} of{" "}
            {list.data.total}
          </span>
          <Button
            variant="outline"
            disabled={offset + 25 >= list.data.total || list.isFetching}
            onClick={() => setOffset((n) => n + 25)}
          >
            Next
          </Button>
        </div>
      )}
      <p className="max-w-3xl text-xs text-muted-foreground">
        Cancellation waits for any in-progress transaction. It succeeds only
        when this request has not completed, then prevents it from running
        later. It does not reverse a saved financial record. Your current
        permissions are checked again for every recovery attempt.
      </p>
    </div>
  );
}
