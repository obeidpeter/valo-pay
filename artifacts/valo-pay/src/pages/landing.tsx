import { useEffect } from 'react';
import { Link } from 'wouter';
import { ArrowRight, CheckCircle2, FileCheck, FileText, RefreshCcw, ShieldCheck } from 'lucide-react';
import { BrandLockup } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { authEnabled, useSessionUser } from '@/lib/auth';

/**
 * The landing page: what Valo Pay is, what it is not, and two ways in.
 *
 * Design rationale (docs/design/landing-and-login.md): one primary action per
 * screen, the descriptor and "we never hold money" inside the first three
 * lines, four equal cards for the four jobs (Gestalt proximity, small
 * multiples), white space as the grouping element, a left-aligned
 * typographic hierarchy, indigo for actions and the brand orange for the mark
 * only, plain words in the lender's own language, and no claim the product
 * cannot show.  This page never creates a sandbox: the workspace bootstrap
 * happens only when someone chooses to open it.
 */

const jobs = [
  { icon: FileText, title: 'Mandate operations', text: "Every provider's mandates in one view. Activation is chased inside its window, and the consent record pins the policy version the customer agreed to." },
  { icon: RefreshCcw, title: 'Retries that follow the rules', text: 'A versioned policy a compliance reviewer approves: notice in advance, caps, quiet hours, a kill switch you control, and every decision logged with the rule that fired.' },
  { icon: CheckCircle2, title: 'Reconciliation every morning', text: 'Direct-debit settlements, transfers and card payments matched to instalments with the rule and the confidence. Anything unmatched gets an owner and a deadline.' },
  { icon: FileCheck, title: 'Audit and dispute packs', text: 'One timeline per customer: consent, schedule, every attempt, every notice, every naira. Exported as a checksummed PDF, CSV or JSON in under a minute.' },
];

const steps = [
  { title: 'Plug in', text: 'By API, or by CSV if you have none, under a partner agreement with your aggregator. Never your API keys.' },
  { title: 'Observe', text: 'We read what happened: webhooks, settlement reports, statements. In observation mode nothing leaves the platform.' },
  { title: 'Instruct, within the rules', text: 'Only after a signed cutover. Retries run inside your execution window, 06:00 to 10:00 WAT by default, never in quiet hours, and never past the policy cap.' },
];

const boundaries = [
  { title: 'Below the rail', text: '₦90 on a ₦30,000 debit, against about ₦150 to your aggregator. Licence tiers from ₦150,000 a month. Prices are public.' },
  { title: 'Not a wallet, not a bank, not a payment provider', text: "Money moves from your customer's bank through NIBSS and your aggregator into your settlement account, exactly as it does today." },
  { title: 'What we do not claim', text: 'We do not switch a failed debit to another provider. We do not promise recovered money until we have measured it on real data.' },
  { title: 'Written to the rules, not "fully compliant"', text: "Retry conduct is written to the CBN's consumer-protection rules and the FCCPC's position on debt-recovery conduct. Identifiers are masked and every action sits on a hash-chained audit trail." },
];

/** A static picture of the console's own daily close, so a visitor recognises the product rather than imagining it. */
function ClosePreview() {
  const rows: Array<[string, string, string]> = [
    ['Payments matched', '1,240', 'R1 certain 96% · R5 proposed 3%'],
    ['Unallocated older than 24h', '3', 'each with an owner and a deadline'],
    ['Retry decisions recorded', '18', '2 deferred for missing notice evidence'],
    ['Dispute packs generated', '5', 'SHA-256 checksum on every export'],
  ];
  return (
    <figure className="rounded-xl border bg-card shadow-sm" aria-labelledby="preview-title">
      <div className="flex items-center justify-between gap-3 border-b bg-secondary/30 px-5 py-3">
        <div>
          <p id="preview-title" className="text-sm font-semibold">Daily close · Meridian Credit</p>
          <p className="text-xs text-muted-foreground">Scheduled 07:00 WAT · ran on time</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success" role="status">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Books complete
        </span>
      </div>
      <dl className="divide-y">
        {rows.map(([label, value, note]) => (
          <div key={label} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 px-5 py-3">
            <dt className="text-sm text-foreground">{label}<span className="block text-xs text-muted-foreground">{note}</span></dt>
            <dd className="font-mono text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <figcaption className="border-t px-5 py-2 text-xs text-muted-foreground">Illustration with synthetic figures. Nothing here is live evidence.</figcaption>
    </figure>
  );
}

export default function LandingPage() {
  const { userId } = useSessionUser();
  useEffect(() => { document.title = 'Valo Pay · Collections operations layer'; }, []);
  const signedIn = authEnabled && Boolean(userId);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to main content</a>

      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <BrandLockup />
          <nav aria-label="Sections" className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
            <a href="#what" className="hover:text-foreground">What it does</a>
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#boundaries" className="hover:text-foreground">What we are not</a>
          </nav>
          <div className="flex items-center gap-2">
            {/* Below the sm breakpoint the lockup and two buttons do not fit one row; the hero's own button is in the first screen. */}
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex"><Link href="/overview">Open the sandbox</Link></Button>
            {signedIn
              ? <Button asChild size="sm"><Link href="/overview">Open your workspace</Link></Button>
              : <Button asChild size="sm"><Link href="/sign-in">Sign in</Link></Button>}
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero: the descriptor is line one, the promise line two, "we never hold money" line three. */}
        <section className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[3fr_2fr] lg:items-center lg:py-20" aria-labelledby="hero-title">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">A collections operations layer for lenders that collect by direct debit</p>
            <h1 id="hero-title" className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">Every naira matched to the bill it was for, by the next morning.</h1>
            <p className="mt-5 text-lg text-muted-foreground">We never hold money. Valo Pay plugs into the aggregator and loan software you already use, gets mandates activated, retries within the rules, reconciles every payment and keeps one clean record per customer.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="gap-2"><Link href="/overview">Open the sandbox <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
              <Button asChild size="lg" variant="outline"><a href="#how">See how it works</a></Button>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">The sandbox needs no sign-in. Synthetic data only; nothing leaves the platform.</p>
            <p className="mt-6 inline-flex items-center gap-2 rounded-full border bg-secondary/40 px-3 py-1 font-mono text-xs text-muted-foreground" role="status">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" /> Stage 1 · observation mode · no live instructions
            </p>
          </div>
          <ClosePreview />
        </section>

        {/* The four jobs: four equal cards so the differences are the content, not the shape. */}
        <section id="what" className="border-t bg-card" aria-labelledby="what-title">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="what-title" className="text-2xl font-bold tracking-tight sm:text-3xl">The four jobs that today live in spreadsheets and call centres</h2>
            <p className="mt-2 max-w-2xl text-muted-foreground">Your loan software creates mandates and debits on the due date, and we pull that from it. The rest is what Valo Pay does.</p>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2" role="list">
              {jobs.map((job) => (
                <li key={job.title} className="rounded-xl border bg-background p-6">
                  <job.icon className="h-6 w-6 text-primary" aria-hidden="true" />
                  <h3 className="mt-4 text-lg font-semibold">{job.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{job.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works: three numbered steps with a beginning, middle and end. */}
        <section id="how" className="border-t" aria-labelledby="how-title">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="how-title" className="text-2xl font-bold tracking-tight sm:text-3xl">How it works</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-3">
              {steps.map((step, index) => (
                <li key={step.title} className="relative rounded-xl border bg-card p-6">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary font-mono text-sm font-semibold text-primary-foreground" aria-hidden="true">{index + 1}</span>
                  <h3 className="mt-4 text-lg font-semibold"><span className="sr-only">Step {index + 1}: </span>{step.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* What we are and are not: the honest column, stated before anyone has to ask. */}
        <section id="boundaries" className="border-t bg-card" aria-labelledby="boundaries-title">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-1 h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <h2 id="boundaries-title" className="text-2xl font-bold tracking-tight sm:text-3xl">What we are, and what we are not</h2>
                <p className="mt-2 max-w-2xl text-muted-foreground">Every number carries its basis. Nothing on this page is a promise the product cannot show you in its own records.</p>
              </div>
            </div>
            <dl className="mt-8 grid gap-6 md:grid-cols-2">
              {boundaries.map((item) => (
                <div key={item.title} className="rounded-xl border bg-background p-6">
                  <dt className="font-semibold">{item.title}</dt>
                  <dd className="mt-2 text-sm text-muted-foreground">{item.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* One last way in, then help. */}
        <section className="border-t" aria-labelledby="cta-title">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 id="cta-title" className="text-2xl font-bold tracking-tight">See it on synthetic data first</h2>
              <p className="mt-2 max-w-xl text-muted-foreground">Two sample lenders, every queue and report, and a daily close you can run yourself. Sign in when you want a workspace that keeps your changes.</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="gap-2"><Link href="/overview">Open the sandbox <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
              {!signedIn && <Button asChild size="lg" variant="outline"><Link href="/sign-in">Sign in</Link></Button>}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t bg-card">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6 md:flex-row md:items-center md:justify-between">
          <p>Valo Pay · Collections operations layer · We never hold money.</p>
          <nav aria-label="Help and documentation" className="flex flex-wrap gap-x-6 gap-y-2">
            <a href="https://github.com/obeidpeter/valo-pay#readme" className="hover:text-foreground">How the sandbox works</a>
            <a href="https://github.com/obeidpeter/valo-pay/blob/main/docs/DATABASE_SECURITY.md" className="hover:text-foreground">Security boundary</a>
            <Link href="/sign-in" className="hover:text-foreground">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
