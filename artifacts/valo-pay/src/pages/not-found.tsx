import { Link } from 'wouter';
import { Button } from '@/components/ui/button';

/**
 * Shown inside the console for any address it has no page for. Plain words
 * that say what happened and that nothing changed, and two ways out; never a
 * message written for the developer (Nielsen 9: help users recognise,
 * diagnose and recover from errors).
 */
export default function NotFound() {
  return (
    <section aria-labelledby="not-found-title" className="mx-auto max-w-md rounded-xl border bg-card p-6">
      <p className="font-mono text-xs text-muted-foreground">404</p>
      <h1 id="not-found-title" className="mt-2 text-2xl font-bold tracking-tight">There is no page at this address</h1>
      <p className="mt-3 text-sm text-muted-foreground">The address may be mistyped, or the page may have moved. Nothing in your workspace has been changed.</p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button asChild><Link href="/overview">Go to the overview</Link></Button>
        <Button asChild variant="outline"><Link href="/">Back to the start</Link></Button>
      </div>
    </section>
  );
}
