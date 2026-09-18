import { Link } from 'wouter';
import { ArrowRight, ArrowUpRight, BadgeCheck, Banknote, Building2, CheckCircle2, ClipboardList, FileCheck, FileText, Landmark, RefreshCcw, ShieldCheck, Users, Wallet } from 'lucide-react';
import { BrandLockup } from '@/components/brand';
import { Button } from '@/components/ui/button';
import '@/landing-sections.css';

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
  { icon: Banknote, id: 'pricing', title: 'Below the rail', text: '₦90 on a ₦30,000 debit, against about ₦150 to your aggregator. Licence tiers from ₦150,000 a month. Prices are public.' },
  { icon: Wallet, title: 'Not a wallet, not a bank, not a payment provider', text: "Money moves from your customer's bank through NIBSS and your aggregator into your settlement account, exactly as it does today." },
  { icon: BadgeCheck, title: 'What we do not claim', text: 'We do not switch a failed debit to another provider. We do not promise recovered money until we have measured it on real data.' },
  { icon: ShieldCheck, title: 'Written to the rules, not "fully compliant"', text: "Retry conduct is written to the CBN's consumer-protection rules and the FCCPC's position on debt-recovery conduct. Identifiers are masked and every action sits on a hash-chained audit trail." },
];

const audiences = [
  { icon: Landmark, title: 'Lenders', text: 'Mandates, collections and customer records in one clear view.' },
  { icon: Users, title: 'Cooperatives', text: 'A shared workspace for your collections operations.' },
  { icon: Building2, title: 'Finance teams', text: 'Review payment matches, exceptions and daily close records.' },
  { icon: ClipboardList, title: 'Operations teams', text: 'Follow activations and the work that needs attention.' },
];

/** Product sections are static: visiting the landing page never creates a workspace. */
export function LandingSections({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <section id="what" className="lp-section lp-jobs-section" aria-labelledby="what-title">
        <div className="public-container">
          <div className="lp-section-intro lp-split-intro">
            <p className="lp-section-kicker">Less chasing. More clarity.</p>
            <h2 id="what-title">The four jobs that today live in spreadsheets and call centres</h2>
            <p>Your loan software creates mandates and debits on the due date, and we pull that from it. The rest is what Valo Pay does.</p>
          </div>
          <ul className="lp-job-grid" role="list">
            {jobs.map((job, index) => (
              <li key={job.title} className="lp-job-card">
                <span className="lp-icon-tile"><job.icon aria-hidden="true" /></span>
                <h3>{job.title}</h3>
                <p>{job.text}</p>
                <span className="lp-card-number" aria-hidden="true">0{index + 1}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="how" className="lp-section lp-process-section" aria-labelledby="how-title">
        <div className="public-container">
          <div className="lp-section-intro lp-split-intro">
            <p className="lp-section-kicker">Fits the way you work</p>
            <h2 id="how-title">How it works</h2>
            <p>Start with visibility. Move to instructions only when the right agreements and controls are in place.</p>
          </div>
          <ol className="lp-process-grid">
            {steps.map((step, index) => (
              <li key={step.title}>
                <div className="lp-process-top"><span className="lp-process-number" aria-hidden="true">0{index + 1}</span>{index < 2 && <ArrowRight aria-hidden="true" />}</div>
                <h3><span className="sr-only">Step {index + 1}: </span>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="boundaries" className="lp-section lp-trust-section" aria-labelledby="boundaries-title">
        <div className="public-container lp-trust-layout">
          <div className="lp-trust-copy">
            <p className="lp-section-kicker">Trust starts with clarity</p>
            <h2 id="boundaries-title">What we are,<br /> and what we are not</h2>
            <p>Every number carries its basis. Nothing on this page is a promise the product cannot show you in its own records.</p>
            <div className="lp-trust-lines" aria-hidden="true"><span /><span /><span /><span /></div>
          </div>
          <dl className="lp-boundary-grid">
            {boundaries.map((item) => (
              <div key={item.title} id={item.id} className="lp-boundary-card">
                <dt><span className="lp-boundary-icon"><item.icon aria-hidden="true" /></span>{item.title}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="lp-section lp-audience-section" aria-labelledby="audience-title">
        <div className="public-container">
          <div className="lp-audience-intro">
            <p className="lp-section-kicker">Built for the teams who keep collections moving</p>
            <h2 id="audience-title" className="sr-only">For the people behind the payments</h2>
          </div>
          <ul className="lp-audience-grid" role="list">
            {audiences.map((audience) => (
              <li key={audience.title}>
                <audience.icon aria-hidden="true" />
                <div><h3>{audience.title}</h3><p>{audience.text}</p></div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="lp-cta-section" aria-labelledby="cta-title">
        <div className="public-container">
          <div className="lp-final-cta">
            <div className="lp-cta-art" aria-hidden="true"><span /><span /><span /><span /></div>
            <div className="lp-cta-copy">
              <p className="lp-section-kicker">Your next morning, reimagined</p>
              <h2 id="cta-title">See it on synthetic data first</h2>
              <p>Two sample lenders, every queue and report, and a daily close you can run yourself. Sign in when you want a workspace that keeps your changes.</p>
            </div>
            <div className="lp-cta-controls">
              <div className="lp-cta-actions">
                <Button asChild size="lg" className="lp-cta-button"><Link href="/overview">Open the sandbox <ArrowUpRight aria-hidden="true" /></Link></Button>
                {!signedIn && <Button asChild size="lg" variant="ghost" className="lp-cta-signin"><Link href="/sign-in">Sign in <ArrowRight aria-hidden="true" /></Link></Button>}
              </div>
              <span className="lp-cta-note"><span aria-hidden="true" /> No sign-in needed. Synthetic data only.</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export function LandingFooter() {
  return (
    <footer className="lp-footer">
      <div className="public-container">
        <div className="lp-footer-main">
          <div className="lp-footer-brand"><BrandLockup /></div>
          <nav aria-label="Product sections" className="lp-footer-links"><a href="#what">What it does</a><a href="#how">How it works</a><a href="#boundaries">Our boundaries</a><a href="#pricing">Pricing</a></nav>
          <nav aria-label="Help and documentation" className="lp-footer-links"><a href="https://github.com/obeidpeter/valo-pay#readme">How the sandbox works</a><a href="https://github.com/obeidpeter/valo-pay/blob/main/docs/DATABASE_SECURITY.md">Security boundary</a><Link href="/sign-in">Sign in</Link></nav>
        </div>
        <div className="lp-footer-bottom"><p>Valo Pay · Collections operations layer · We never hold money.</p><div className="lp-footer-location"><span>Built for collections in Nigeria.</span><span className="lp-nigerian-flag" aria-hidden="true" /></div></div>
      </div>
    </footer>
  );
}
