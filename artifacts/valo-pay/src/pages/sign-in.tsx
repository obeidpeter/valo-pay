import { useEffect, type ReactNode } from 'react';
import { Link } from 'wouter';
import { SignIn, SignUp } from '@clerk/react';
import { ArrowLeft, ArrowRight, Info } from 'lucide-react';
import { BrandLockup } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { authEnabled } from '@/lib/auth';

/**
 * Sign-in and sign-up in a shell that matches the console: the brand and
 * what signing in changes on one side, the form on the other.  The form
 * itself is Clerk's, themed to the console's tokens, because it already
 * handles every strategy, its errors are in plain language and its labels are
 * visible.  Where Clerk is not configured there is no account to sign into,
 * and the page says so and offers the sandbox instead of a form that could
 * not work (visibility of system status; help users recognise and recover).
 */

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Clerk's form in the console's colours, type and radius. */
const appearance = {
  variables: {
    colorPrimary: 'hsl(232 47% 16%)',
    colorText: 'hsl(232 47% 16%)',
    colorTextSecondary: 'hsl(215 16% 47%)',
    colorBackground: 'hsl(0 0% 100%)',
    colorInputBackground: 'hsl(0 0% 100%)',
    colorInputText: 'hsl(232 47% 16%)',
    colorDanger: 'hsl(348 83% 47%)',
    borderRadius: '0.5rem',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  },
  elements: {
    rootBox: 'w-full',
    cardBox: 'w-full shadow-none',
    card: 'shadow-none border border-border rounded-xl',
  },
} as const;

const whatChanges = [
  'Your lenders, mandates, reconciliation and settings are kept between visits.',
  'A signed-in workspace is never removed. An anonymous sandbox is removed after 30 days without a change.',
  'We never hold money. Nothing in this console moves funds, signed in or not.',
];

function Shell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Valo Pay`; }, [title]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to main content</a>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <BrandLockup />
          <Link href="/" className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to the start</Link>
        </div>
      </header>
      <main id="main" className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[2fr_3fr] lg:items-start lg:py-16">
        <aside aria-labelledby="context-title" className="lg:pt-6">
          <h1 id="context-title" className="text-3xl font-bold tracking-tight">{title}</h1>
          <p className="mt-3 text-muted-foreground">A collections operations layer for lenders that collect by direct debit. We never hold money.</p>
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-muted-foreground">What signing in changes</h2>
          <ul className="mt-3 space-y-3 text-sm" role="list">
            {whatChanges.map((line) => (
              <li key={line} className="flex gap-3"><Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><span>{line}</span></li>
            ))}
          </ul>
          <p className="mt-8 inline-flex items-center gap-2 rounded-full border bg-secondary/40 px-3 py-1 font-mono text-xs text-muted-foreground" role="status">
            <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" /> Stage 1 · synthetic sandbox
          </p>
        </aside>
        <div className="w-full max-w-md lg:justify-self-end">{children}</div>
      </main>
    </div>
  );
}

/** When this host has no Clerk key there is no account to sign into: say so, say why, and offer the sandbox. */
function Unavailable({ action }: { action: 'sign in' | 'create an account' }) {
  return (
    <section aria-labelledby="unavailable-title" className="rounded-xl border bg-card p-6 shadow-sm">
      <h2 id="unavailable-title" className="text-xl font-semibold">Sign-in isn't available on this host</h2>
      <p className="mt-3 text-sm text-muted-foreground">Sign-in runs on Clerk, and this host has no Clerk key, so you cannot {action} here. On the deployed address the form appears in this place.</p>
      <p className="mt-3 text-sm text-muted-foreground">Everything in the synthetic sandbox still works without an account.</p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button asChild className="gap-2"><Link href="/overview">Continue to the sandbox <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
        <Button asChild variant="outline"><Link href="/">Back to the start</Link></Button>
      </div>
    </section>
  );
}

export function SignInPage() {
  return (
    <Shell title="Sign in to your workspace">
      {authEnabled ? (
        <>
          <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} fallbackRedirectUrl={`${basePath}/overview`} appearance={appearance} />
          <p className="mt-4 text-sm text-muted-foreground">Just looking? <Link href="/overview" className="font-medium text-primary underline-offset-4 hover:underline">Open the sandbox without an account</Link>.</p>
        </>
      ) : <Unavailable action="sign in" />}
    </Shell>
  );
}

export function SignUpPage() {
  return (
    <Shell title="Create your workspace">
      {authEnabled ? (
        <>
          <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/overview`} appearance={appearance} />
          <p className="mt-4 text-sm text-muted-foreground">Just looking? <Link href="/overview" className="font-medium text-primary underline-offset-4 hover:underline">Open the sandbox without an account</Link>.</p>
        </>
      ) : <Unavailable action="create an account" />}
    </Shell>
  );
}
