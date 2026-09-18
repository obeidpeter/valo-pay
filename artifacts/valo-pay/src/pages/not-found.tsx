import { useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { PublicFrame } from '@/components/public-frame';

/**
 * Two not-found states, both in plain words that say what was looked for,
 * that nothing changed, and where to go next (Nielsen 9: help users
 * recognise, diagnose and recover).  NotFoundPage answers an address the
 * console has no page for; App.tsx routes it outside the workspace
 * provider, so a mistyped address or a stray crawler creates no sandbox.
 * NotFoundNotice is for a page that exists but whose record does not, shown
 * inside the console with the sidebar still there as the way out.
 */

type Action = { href: string; label: string };

/** The reference or address that was looked for, shown exactly so a typo can be seen. */
export function LookedFor({ children }: { children: ReactNode }) {
  return <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>;
}

export function NotFoundNotice({ title, children, primary, secondary }: { title: string; children: ReactNode; primary: Action; secondary?: Action }) {
  return (
    <section aria-labelledby="not-found-title" className="max-w-lg rounded-xl border bg-card p-6">
      <h1 id="not-found-title" className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">{children}</div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button asChild><Link href={primary.href}>{primary.label}</Link></Button>
        {secondary && <Button asChild variant="outline"><Link href={secondary.href}>{secondary.label}</Link></Button>}
      </div>
    </section>
  );
}

export default function NotFoundPage() {
  const [location] = useLocation();
  useEffect(() => { document.title = 'Page not found · Valo Pay'; }, []);
  return (
    <PublicFrame>
      <main id="main" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
        <NotFoundNotice title="There is no page at this address" primary={{ href: '/overview', label: 'Go to the overview' }} secondary={{ href: '/', label: 'Back to the start' }}>
          <p>We looked for <LookedFor>{location}</LookedFor> and the console has no page with that address. It may be mistyped, or the page may have moved.</p>
          <p>Nothing has been changed.</p>
        </NotFoundNotice>
      </main>
    </PublicFrame>
  );
}
