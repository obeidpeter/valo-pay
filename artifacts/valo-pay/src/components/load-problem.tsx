import { Button } from '@/components/ui/button';
import { saidBy } from '@/lib/notify';

/** A failed request is never presented as an empty list. */
export function LoadProblem({ what, error, retry, busy = false }: { what: string; error: unknown; retry: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-5 text-sm">
      <p className="font-semibold">Unable to load {what}</p>
      <p className="mt-2 text-muted-foreground">{saidBy(error, 'The service could not be reached. Check your connection and try again.')}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={retry} busy={busy} busyLabel="Trying again…">Try again</Button>
    </div>
  );
}
