import { useEffect, useState } from "react";
import { Link, useSearchParams } from "wouter";
import {
  useListCloseHistory,
  getListCloseHistoryQueryKey,
  useGetCloseDetail,
  getGetCloseDetailQueryKey,
  type ValopayRecord,
} from "@workspace/api-client-react";
import { useWorkspace } from "@/lib/workspace-context";
import { useUrlPagination } from "@/lib/use-url-pagination";
import { closeHistory } from "@/lib/close-history";
import {
  formatCount,
  formatDate,
  formatKobo,
  formatNumber,
} from "@/lib/formatters";
import { Button } from "./ui/button";
import { RecordPagination } from "./record-pagination";
import { LoadProblem, RefreshProblem } from "./load-problem";

function CloseEvidence({ close }: { close: ValopayRecord }) {
  const { merchantId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const params = { merchantId: merchantId! };
  const query = useGetCloseDetail(close.id, params, {
    query: {
      enabled: open && !!merchantId,
      queryKey: getGetCloseDetailQueryKey(close.id, params),
    },
  });
  const report = query.data?.data?.report as Record<string, any> | undefined;
  // A count from the recorded report, grouped the market's way; one the report left out is 0.
  const count = (value: unknown) => formatNumber(Number(value ?? 0));
  const money = (value: any) =>
    `${count(value?.count)} · ${formatKobo(Number(value?.kobo || 0))}`;
  const measures = report
    ? [
        ["Unmatched at start", money(report.openingUnallocated)],
        [
          "Payment records received",
          count(report.observations?.received),
        ],
        [
          "Payment records by source",
          Object.entries(report.observations?.bySource || {})
            .map(
              ([key, v]: [string, any]) =>
                `${key}: ${formatCount(Number(v.received ?? 0), "record")} linked to ${formatCount(v.paymentsResolvedTo, "payment")}`,
            )
            .join("; ") || "None",
        ],
        [
          "Matches by rule",
          Object.entries(report.allocatedByRule || {})
            .map(([key, v]: [string, any]) => `${key}: ${count(v.count)}`)
            .join("; ") || "None",
        ],
        ["Proposed matches", money(report.proposed)],
        [
          "Unmatched at close",
          `${money(report.unallocated)} · ${count(report.unallocated?.olderThan24Hours)} older than 24 hours`,
        ],
        [
          "Settlement differences",
          `${count(report.variances?.count)} · ${formatKobo(Number(report.variances?.feeVarianceKobo || 0))}`,
        ],
        [
          "Exceptions",
          `${count(report.exceptions?.opened?.count)} opened · ${count(report.exceptions?.closed?.count)} closed · ${count(report.exceptions?.openAtClose)} open`,
        ],
        [
          "Customer totals changed",
          count(report.customerPositionsChanged?.length),
        ],
        [
          "Retry decisions",
          `${count(report.retryDecisions?.recorded)} recorded · ${formatCount(Number(report.retryDecisions?.finalAttempts ?? 0), "final attempt")} · ${count(report.retryDecisions?.noticesNotEvidenced)} deferred for missing notice evidence`,
        ],
      ]
    : [];
  return (
    <details
      className="min-w-0 rounded-lg border bg-card print:hidden"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">
        View close details
      </summary>
      {open && (
        <div className="space-y-3 border-t p-3 text-xs [overflow-wrap:anywhere]">
          {query.error ? (
            <LoadProblem
              what="this close report"
              error={query.error}
              retry={() => {
                void query.refetch();
              }}
            />
          ) : query.isLoading ? (
            <p role="status">Loading close evidence…</p>
          ) : report ? (
            <dl className="space-y-3">
              {measures.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>Detailed reports were not available when this close ran.</p>
          )}
          {query.data?.data?.positionAlert === true && (
            <p className="text-destructive">Customer totals need review</p>
          )}
          {!!query.data?.data?.schedule && (
            <p>
              {String((query.data.data.schedule as any).trigger || "manual")}
              {(query.data.data.schedule as any).late
                ? ` · ${count((query.data.data.schedule as any).delayMinutes)} min late`
                : ""}
            </p>
          )}
        </div>
      )}
    </details>
  );
}

export function CloseHistorySection({ active }: { active: boolean }) {
  const { merchantId } = useWorkspace();
  const [search, setSearch] = useSearchParams();
  const from = search.get("from") || "",
    to = search.get("to") || "",
    validation = closeHistory([], from, to);
  const pagination = useUrlPagination(merchantId, "close-");
  const params = {
    merchantId: merchantId!,
    from: from || undefined,
    to: to || undefined,
    limit: pagination.pageSize,
    offset: pagination.offset,
  };
  const query = useListCloseHistory(params, {
    query: {
      enabled: !!merchantId && active && !validation.error,
      queryKey: getListCloseHistoryQueryKey(params),
    },
  });
  useEffect(() => {
    if (query.data && query.data.offset !== pagination.offset)
      pagination.correctPage(Math.floor(query.data.offset / pagination.pageSize));
  }, [query.data, pagination.offset, pagination.pageSize]);
  const history = closeHistory(
    query.data?.first && query.data.latest
      ? query.data.first.id === query.data.latest.id
        ? [query.data.first]
        : [query.data.first, query.data.latest]
      : [],
    "",
    "",
  );
  const apply = (values?: FormData) =>
    setSearch((current) => {
      const next = new URLSearchParams(current);
      next.delete("close-page");
      for (const key of ["from", "to"]) {
        const value = String(values?.get(key) || "");
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  return (
    <>
      <div className="space-y-4 border-b p-5">
        <Link href="/close-review" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline print:hidden">Prepare and review a close with Finance</Link>
        <form
          key={`${merchantId}:${from}:${to}`}
          className="flex flex-wrap items-end gap-3 print:hidden"
          onSubmit={(event) => {
            event.preventDefault();
            apply(new FormData(event.currentTarget));
          }}
        >
          <label className="grid gap-1 text-xs font-medium">
            From date (WAT)
            <input
              type="date"
              name="from"
              defaultValue={from}
              aria-invalid={!!validation.error}
              aria-describedby="close-range-help"
              className="min-h-10 max-w-full rounded-md border bg-background px-3"
            />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            To date (WAT)
            <input
              type="date"
              name="to"
              defaultValue={to}
              aria-invalid={!!validation.error}
              aria-describedby="close-range-help"
              className="min-h-10 max-w-full rounded-md border bg-background px-3"
            />
          </label>
          <Button type="submit" variant="outline">
            Apply dates
          </Button>
          {(from || to) && (
            <Button type="button" variant="ghost" onClick={() => apply()}>
              Clear dates
            </Button>
          )}
        </form>
        <p id="close-range-help" className="text-xs text-muted-foreground">
          {validation.error ||
            (query.data
              ? `Showing ${formatCount(query.data.total, "recorded close")}${from ? ` from ${from}` : ""}${to ? ` through ${to}` : ""}. Dates include the full day in West Africa Time. Current totals above are unchanged.`
              : "Loading recorded closes…")}
        </p>
        {!validation.error && (
          <RefreshProblem what="The close history" shown="closes" query={query} />
        )}
        {validation.error ? (
          <p role="alert" className="text-sm text-destructive">
            The close history is hidden until the date range is corrected.
          </p>
        ) : query.error && !query.data ? (
          <LoadProblem
            what="daily close history"
            error={query.error}
            retry={() => {
              void query.refetch();
            }}
          />
        ) : (
          query.data && (
            <div className="rounded-lg bg-secondary/25 p-4">
              <h3 className="text-sm font-semibold">
                Change between recorded closes
              </h3>
              {query.data.total < 2 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  At least two recorded closes in this range are needed for a
                  comparison. No change has been estimated.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">
                    First: {formatDate(history.first!.createdAt)} · Latest:{" "}
                    {formatDate(history.latest!.createdAt)}. These are closing
                    positions, not money collected during the period.
                  </p>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    {history.metrics.map((metric) => (
                      <div key={metric.label}>
                        <p className="text-xs text-muted-foreground">
                          {metric.label}
                        </p>
                        <p className="mt-1 text-lg font-semibold tabular-nums">
                          {metric.change === null
                            ? "Not available"
                            : `${metric.change > 0 ? "+" : ""}${metric.money ? formatKobo(metric.change) : formatNumber(metric.change)}`}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {metric.change === null
                            ? "One or both closes lack this recorded measure."
                            : `${metric.money ? formatKobo(metric.before) : formatNumber(metric.before)} → ${metric.money ? formatKobo(metric.after) : formatNumber(metric.after)}`}
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        )}
      </div>
      {!validation.error && query.data && (
        <>
          {!query.data.items.length ? (
            <div className="p-5">
              <p className="font-medium">
                {query.data.allTotal
                  ? "No closes in this date range"
                  : "No daily close yet"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {query.data.allTotal
                  ? "Choose another date range to view recorded closes."
                  : "Run a daily close above to check the books. Each completed close creates a record with its results here."}
              </p>
            </div>
          ) : (
            <ol aria-label="Recorded daily closes" className="divide-y">
              {query.data.items.map((close) => (
                <li
                  key={close.id}
                  className="grid min-w-0 gap-3 p-5 md:grid-cols-[9rem_minmax(0,1fr)_minmax(12rem,1fr)]"
                >
                  <time
                    dateTime={close.createdAt}
                    className="text-xs font-medium tabular-nums"
                  >
                    {formatDate(close.createdAt)}
                  </time>
                  <p className="min-w-0 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {String(close.data.summary || "Recorded daily close")}
                  </p>
                  <div className="min-w-0 space-y-2"><CloseEvidence key={`${merchantId}:${close.id}`} close={close} /><Link href={`/close-review?close=${encodeURIComponent(close.id)}`} className="inline-flex min-h-11 items-center text-sm text-primary underline print:hidden">View Finance review</Link></div>
                </li>
              ))}
            </ol>
          )}
          <p className="hidden px-5 py-2 text-xs print:block">
            Close summaries only. Open a close in the console to inspect its
            full evidence.
          </p>
          <RecordPagination
            pagination={pagination}
            total={query.data.total}
            label="recorded closes"
            busy={query.isFetching}
          />
        </>
      )}
    </>
  );
}
