import { useEffect } from 'react';
import { Link } from 'wouter';
import { ArrowRight, ArrowUpRight, Check, CheckCircle2, CircleDot, FileCheck, FileText, LayoutDashboard, RefreshCcw, ShieldCheck, Users } from 'lucide-react';
import { BrandLockup } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { authEnabled, useSessionUser } from '@/lib/auth';
import '@/public-pages.css';

/**
 * The landing page: what Valo Pay is, what it is not, and two ways in.
 *
 * The descriptor, promise and custody boundary remain the first three
 * lines. The preview is explicitly synthetic and the four jobs have equal
 * emphasis. Reading this page never creates a sandbox: workspace bootstrap
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
  return (
    <div className="close-preview-stage">
      <div className="preview-orbit preview-orbit-one" aria-hidden="true" />
      <div className="preview-orbit preview-orbit-two" aria-hidden="true" />
      <figure className="close-preview" aria-labelledby="preview-title">
        <div className="preview-toolbar">
          <span className="inline-flex items-center gap-2 font-semibold"><span className="preview-brand-dot" aria-hidden="true">V</span> Valo Pay</span>
          <span className="preview-environment">Sandbox preview</span>
        </div>
        <div className="preview-workspace">
          <div className="preview-rail" aria-hidden="true">
            <LayoutDashboard className="preview-rail-active" />
            <Users />
            <FileText />
            <RefreshCcw />
            <ShieldCheck />
          </div>
          <div className="preview-content">
            <div className="preview-heading">
              <div><p className="preview-eyebrow">MERIDIAN CREDIT</p><h2 id="preview-title">A clearer close.</h2></div>
              <span className="preview-check"><CheckCircle2 aria-hidden="true" /></span>
            </div>
            <p className="text-xs text-muted-foreground">Daily close · Scheduled 07:00 WAT</p>
            <div className="preview-total">
              <span className="text-sm text-muted-foreground">Payments matched</span>
              <strong>1,240<span className="preview-complete"><Check className="h-3 w-3" aria-hidden="true" /> Books complete</span></strong>
              <div className="preview-match-bar" aria-hidden="true"><span /><span /><span /></div>
              <p className="text-xs text-muted-foreground">R1 certain 96% · R5 proposed 3%</p>
            </div>
            <dl className="preview-records">
              <div><dt><span className="preview-record-icon"><CircleDot aria-hidden="true" /></span><span>Unallocated older than 24h<small>Each with an owner and a deadline</small></span></dt><dd>3</dd></div>
              <div><dt><span className="preview-record-icon"><RefreshCcw aria-hidden="true" /></span><span>Retry decisions recorded<small>2 deferred for missing notice evidence</small></span></dt><dd>18</dd></div>
              <div><dt><span className="preview-record-icon"><FileCheck aria-hidden="true" /></span><span>Dispute packs generated<small>SHA-256 checksum on every export</small></span></dt><dd>5</dd></div>
            </dl>
          </div>
        </div>
        <figcaption>Illustration with synthetic figures. Nothing here is live evidence.</figcaption>
      </figure>
      <div className="preview-footnote"><span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" /> One record. Every payment accounted for.</div>
    </div>
  );
}

export default function LandingPage() {
  const { userId } = useSessionUser();
  useEffect(() => { document.title = 'Valo Pay · Collections operations layer'; }, []);
  const signedIn = authEnabled && Boolean(userId);

  return (
    <div className="public-site min-h-screen bg-background text-foreground">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to main content</a>

      <header className="public-header">
        <div className="public-container flex items-center justify-between gap-4 py-5">
          <BrandLockup />
          <nav aria-label="Sections" className="hidden items-center gap-6 text-sm font-medium text-muted-foreground lg:flex">
            <a href="#what" className="hover:text-foreground">What it does</a>
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#boundaries" className="hover:text-foreground">Our boundaries</a>
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
        <section className="public-container landing-hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="public-eyebrow">A collections operations layer for lenders that collect by direct debit</p>
            <h1 id="hero-title">Every naira matched to the bill it was for, <span>by the next morning.</span></h1>
            <p className="hero-description">We never hold money. Valo Pay plugs into the aggregator and loan software you already use, gets mandates activated, retries within the rules, reconciles every payment and keeps one clean record per customer.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="public-primary gap-2"><Link href="/overview">Open the sandbox <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
              <Button asChild size="lg" variant="outline"><a href="#how">See how it works</a></Button>
            </div>
            <p className="mt-4 max-w-sm text-xs leading-relaxed text-muted-foreground">The sandbox needs no sign-in. Synthetic data only; nothing leaves the platform.</p>
            <p className="hero-stage" role="status">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" /> Stage 1 · observation mode · no live instructions
            </p>
          </div>
          <ClosePreview />
        </section>

        {/* The four jobs: four equal cards so the differences are the content, not the shape. */}
        <section id="what" className="public-section border-y bg-card" aria-labelledby="what-title">
          <div className="public-container">
            <div className="public-section-heading"><div><p className="public-eyebrow">LESS CHASING. MORE CLARITY.</p><h2 id="what-title">The four jobs that today live in spreadsheets and call centres</h2></div><p>Your loan software creates mandates and debits on the due date, and we pull that from it. The rest is what Valo Pay does.</p></div>
            <ul className="jobs-grid" role="list">
              {jobs.map((job, index) => (
                <li key={job.title} className="job-card">
                  <div className="flex items-center justify-between"><span className="job-icon"><job.icon className="h-5 w-5" aria-hidden="true" /></span><span className="font-mono text-xs text-muted-foreground" aria-hidden="true">0{index + 1}</span></div>
                  <h3 className="mt-7 text-lg font-semibold">{job.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{job.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works: three numbered steps with a beginning, middle and end. */}
        <section id="how" className="public-section" aria-labelledby="how-title">
          <div className="public-container">
            <div className="public-section-heading"><div><p className="public-eyebrow">FITS THE WAY YOU WORK</p><h2 id="how-title">How it works</h2></div><p>Start with visibility. Move to instructions only when the right agreements and controls are in place.</p></div>
            <ol className="steps-grid">
              {steps.map((step, index) => (
                <li key={step.title} className="step-item">
                  <div className="step-track"><span aria-hidden="true">0{index + 1}</span>{index < 2 && <ArrowRight aria-hidden="true" />}</div>
                  <h3 className="mt-6 text-lg font-semibold"><span className="sr-only">Step {index + 1}: </span>{step.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* What we are and are not: the honest column, stated before anyone has to ask. */}
        <section id="boundaries" className="public-section border-y bg-card" aria-labelledby="boundaries-title">
          <div className="public-container boundary-layout">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-1 h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <p className="public-eyebrow">TRUST STARTS WITH CLARITY</p>
                <h2 id="boundaries-title" className="mt-4 text-3xl font-semibold leading-tight tracking-tight">What we are, and what we are not</h2>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">Every number carries its basis. Nothing on this page is a promise the product cannot show you in its own records.</p>
              </div>
            </div>
            <dl className="boundaries-list">
              {boundaries.map((item) => (
                <div key={item.title}>
                  <dt className="font-semibold">{item.title}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* One last way in, then help. */}
        <section className="public-section" aria-labelledby="cta-title">
          <div className="public-container"><div className="public-cta">
            <div>
              <p className="public-eyebrow">YOUR NEXT MORNING, REIMAGINED</p>
              <h2 id="cta-title" className="mt-4 text-3xl font-semibold tracking-tight">See it on synthetic data first</h2>
              <p className="mt-4 max-w-xl text-sm leading-relaxed opacity-75">Two sample lenders, every queue and report, and a daily close you can run yourself. Sign in when you want a workspace that keeps your changes.</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="cta-primary gap-2"><Link href="/overview">Open the sandbox <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
              {!signedIn && <Button asChild size="lg" variant="ghost" className="cta-secondary"><Link href="/sign-in">Sign in <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>}
            </div>
          </div></div>
        </section>
      </main>

      <footer className="border-t bg-card">
        <div className="public-container flex flex-col gap-4 py-8 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
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
