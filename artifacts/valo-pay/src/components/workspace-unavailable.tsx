import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { LookedFor, Notice } from '@/components/notice';
import { PublicFrame } from '@/components/public-frame';
import { AuthShow } from '@/lib/auth';
import { formatDate } from '@/lib/formatters';

/**
 * Shown in place of the console when the workspace request fails. Nothing
 * in the console works without a workspace, so this replaces the pages
 * rather than sitting inside them, in the same frame and card as the other
 * notices. It says what happened in the words the situation calls for,
 * that no lender data has been changed, and offers Try again with its
 * progress visible, the start and, where sign-in exists, sign-in
 * (Nielsen 1 and 9; Dix: recoverability; Shneiderman: informative feedback).
 */

export type WorkspaceExplanation = { title: string; lines: string[]; reportTime?: boolean };

/**
 * The API's own 4xx wording is plain language written for the person
 * reading it (a refused new sandbox, the request limit), so it is shown as
 * is. A 5xx body may carry internals, so it is not shown; a network failure
 * has no body at all.
 */
export function explainWorkspaceError(error: unknown): WorkspaceExplanation {
  const status = (error as { status?: unknown } | null)?.status;
  const said = (error as { data?: { error?: unknown } } | null)?.data?.error;
  const message = typeof said === 'string' && said.trim() ? said.trim() : '';
  if (typeof status !== 'number') return { title: 'The console could not reach the service', lines: ['Check your connection and try again.'] };
  if (status === 429) return { title: 'The service asked you to wait', lines: [message || 'Too many requests from this address. Try again shortly.'] };
  if (status >= 500) return { title: 'The service hit an error', lines: ['It did not finish loading your workspace. Try again in a moment.'], reportTime: true };
  return { title: 'Could not load your workspace', lines: [message || 'The service refused the request.'] };
}

export function WorkspaceUnavailable({ error, retry, busy }: { error: unknown; retry: () => void; busy: boolean }) {
  const [at] = useState(() => new Date().toISOString());
  const { title, lines, reportTime } = explainWorkspaceError(error);
  useEffect(() => { document.title = 'Workspace not loaded · Valo Pay'; }, []);
  return (
    <PublicFrame>
      <main id="main" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
        <Notice
          role="alert"
          title={title}
          actions={<>
            <Button onClick={retry} disabled={busy}>{busy ? 'Trying again…' : 'Try again'}</Button>
            <AuthShow when="signed-out"><Button asChild variant="outline"><Link href="/sign-in">Sign in</Link></Button></AuthShow>
            <Button asChild variant="outline"><Link href="/">Back to the start</Link></Button>
          </>}
        >
          {lines.map((line) => <p key={line}>{line}</p>)}
          {reportTime && <p>If it continues, tell us the time: <LookedFor>{formatDate(at)}</LookedFor>.</p>}
          <p>No lender data has been changed.</p>
        </Notice>
      </main>
    </PublicFrame>
  );
}
