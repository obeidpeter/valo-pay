import { useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { LookedFor, Notice } from '@/components/notice';
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

/** The not-found notice, with a primary and an optional secondary way out. */
export function NotFoundNotice({ title, children, primary, secondary }: { title: string; children: ReactNode; primary: Action; secondary?: Action }) {
  return (
    <Notice
      title={title}
      actions={<>
        <Button asChild><Link href={primary.href}>{primary.label}</Link></Button>
        {secondary && <Button asChild variant="outline"><Link href={secondary.href}>{secondary.label}</Link></Button>}
      </>}
    >
      {children}
    </Notice>
  );
}

/** The page for an address the console has no page for; it creates no sandbox. */
export default function NotFoundPage() {
  const [location] = useLocation();
  useEffect(() => { document.title = 'Page not found · Valo Pay'; }, []);
  return (
    <PublicFrame>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16 focus:outline-none">
        <NotFoundNotice title="There is no page at this address" primary={{ href: '/overview', label: 'Go to the overview' }} secondary={{ href: '/', label: 'Back to the start' }}>
          <p>We looked for <LookedFor>{location}</LookedFor> and the console has no page with that address. It may be mistyped, or the page may have moved.</p>
          <p>Nothing has been changed.</p>
        </NotFoundNotice>
      </main>
    </PublicFrame>
  );
}
