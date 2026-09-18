import { useEffect, type ReactNode } from 'react';
import { Link } from 'wouter';
import { SignIn, SignUp } from '@clerk/react';
import { dark } from '@clerk/themes';
import { useTheme } from '@/lib/theme';
import { ArrowRight, CheckCircle2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { PublicFrame } from '@/components/public-frame';
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
    colorPrimary: 'hsl(var(--primary))',
    colorText: 'hsl(var(--foreground))',
    colorTextSecondary: 'hsl(var(--muted-foreground))',
    colorBackground: 'hsl(var(--card))',
    colorInputBackground: 'hsl(var(--background))',
    colorInputText: 'hsl(var(--foreground))',
    colorDanger: 'hsl(var(--destructive))',
    borderRadius: '0.75rem',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  },
  elements: {
    rootBox: 'w-full',
    cardBox: 'w-full shadow-none',
    card: 'shadow-none border border-border rounded-xl',
  },
} as const;

/** The same form on a dark console: Clerk's dark base theme with the console's dark tokens, so the door matches the room. */
const darkAppearance = {
  ...appearance,
  baseTheme: dark,
  variables: {
    ...appearance.variables,
    colorTextOnPrimaryBackground: 'hsl(var(--primary-foreground))',
  },
};

function useClerkAppearance() {
  const { theme } = useTheme();
  return theme === 'dark' ? darkAppearance : appearance;
}

const whatChanges = [
  'Keep your lenders, mandates, payment matches and settings between visits.',
  'Signed-in workspaces are not removed for inactivity. Anonymous sandboxes can be removed after 30 days without changes.',
  'We never hold money. Nothing in this console moves funds, signed in or not.',
];

function Shell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Valo Pay`; }, [title]);
  return (
    <PublicFrame>
      <main id="main" tabIndex={-1} className="public-container public-auth focus:outline-none">
        <aside aria-labelledby="context-title" className="auth-context">
          <p className="public-eyebrow mb-5">Every payment. One clear picture.</p>
          <h1 id="context-title">{title}</h1>
          <p className="auth-intro">A collections operations layer for lenders that collect by direct debit. We never hold money.</p>
          <h2 className="public-eyebrow mt-10">Why sign in?</h2>
          <ul className="auth-benefits" role="list">
            {whatChanges.map((line) => (
              <li key={line}><CheckCircle2 aria-hidden="true" /><span>{line}</span></li>
            ))}
          </ul>
          <p className="hero-stage" role="status">
            <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" /> Sandbox · Sample data only
          </p>
        </aside>
        <div className="auth-form-area">{children}<p className="auth-footnote"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Sample data only. No live collections.</p></div>
      </main>
    </PublicFrame>
  );
}

/** When this host has no Clerk key there is no account to sign into: say so, say why, and offer the sandbox. */
function Unavailable({ action }: { action: 'sign in' | 'create an account' }) {
  return (
    <section aria-labelledby="unavailable-title" className="auth-unavailable">
      <span className="auth-unavailable-icon"><LockKeyhole className="h-5 w-5" aria-hidden="true" /></span>
      <h2 id="unavailable-title">Sign-in is unavailable here</h2>
      <p>You cannot {action} at this address. You can explore the sandbox without an account.</p>
      <p className="auth-sandbox-note"><strong>Explore with sample data</strong>Try customer timelines, review payment matches and run the daily close to check payment records.</p>
      <div className="auth-unavailable-actions">
        <Button asChild className="gap-2"><Link href="/overview">Continue to the sandbox <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
        <Button asChild variant="ghost"><Link href="/">Back to home</Link></Button>
      </div>
    </section>
  );
}

/** The sign-in page: Clerk's form beside what signing in changes, or the unavailable notice on a host without a key. */
export function SignInPage() {
  const clerkAppearance = useClerkAppearance();
  return (
    <Shell title="Sign in to your workspace">
      {authEnabled ? (
        <>
          <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} fallbackRedirectUrl={`${basePath}/overview`} appearance={clerkAppearance} />
          <p className="mt-4 text-sm text-muted-foreground">Want to try it first? <Link href="/overview" className="font-medium text-primary underline-offset-4 hover:underline">Open the sandbox without an account</Link>.</p>
        </>
      ) : <Unavailable action="sign in" />}
    </Shell>
  );
}

/** The sign-up page, in the same shell. */
export function SignUpPage() {
  const clerkAppearance = useClerkAppearance();
  return (
    <Shell title="Create your workspace">
      {authEnabled ? (
        <>
          <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/overview`} appearance={clerkAppearance} />
          <p className="mt-4 text-sm text-muted-foreground">Want to try it first? <Link href="/overview" className="font-medium text-primary underline-offset-4 hover:underline">Open the sandbox without an account</Link>.</p>
        </>
      ) : <Unavailable action="create an account" />}
    </Shell>
  );
}
