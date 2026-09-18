import { Link } from 'wouter';
import { ArrowRight, ArrowUpRight, BadgeCheck, Banknote, Building2, CheckCircle2, ClipboardList, FileCheck, FileText, Landmark, RefreshCcw, ShieldCheck, Users, Wallet } from 'lucide-react';
import { BrandLockup } from '@/components/brand';
import { Button } from '@/components/ui/button';
import '@/landing-sections.css';

const jobs = [
  { icon: FileText, title: 'Manage mandates', text: "Track each provider's direct debit permissions (mandates) in one place. Follow up on activation before the deadline. Keep consent linked to the policy the customer accepted." },
  { icon: RefreshCcw, title: 'Control retry rules', text: 'A compliance reviewer approves each policy version. Set notice periods, attempt limits and quiet hours. Use the emergency stop to block retries. Each decision records the rule applied.' },
  { icon: CheckCircle2, title: 'Match payments to instalments', text: 'Match settled direct debits, transfers and card payments to instalments. See the rule used and how certain each match is. Give unmatched payments an owner and a deadline.' },
  { icon: FileCheck, title: 'Export audit and dispute records', text: "See each customer's consent, schedule, attempts, notices and payments in one timeline. Export a PDF, CSV or JSON file with a checksum to verify that it has not changed." },
];

const steps = [
  { title: 'Connect your data', text: 'Connect through your payment provider (aggregator) under a partner agreement, or import CSV files. You do not need to share your API keys.' },
  { title: 'Review activity', text: 'Review payment updates, settlement reports and bank statements. In observation mode, Valo Pay records activity without sending collection instructions.' },
  { title: 'Enable controlled retries', text: 'Enable retry instructions only after signed approval to go live. Retries stay within your collection window, 06:00 to 10:00 West Africa Time by default, outside quiet hours and within your attempt limit.' },
];

const boundaries = [
  { icon: Banknote, id: 'pricing', title: 'Clear pricing', text: 'Example fees on a ₦30,000 debit: ₦90 for Valo Pay and about ₦150 for your aggregator. Monthly licences start at ₦150,000.' },
  { icon: Wallet, title: 'Not a wallet, not a bank, not a payment provider', text: "Payments move from your customer's bank through Nigeria's interbank payment network and your payment provider into your settlement account. Valo Pay does not hold these funds." },
  { icon: BadgeCheck, title: 'What we do not claim', text: 'We do not retry failed debits through a different provider. We do not claim improved recovery until results have been measured with real data.' },
  { icon: ShieldCheck, title: 'Conduct rules and audit records', text: 'Retry rules are written around CBN consumer-protection and FCCPC debt-recovery requirements. This is not a claim of full compliance. Identifiers are masked, and linked audit records help detect changes.' },
];

const audiences = [
  { icon: Landmark, title: 'Lenders', text: 'Mandates, collections and customer records in one clear view.' },
  { icon: Users, title: 'Cooperatives', text: 'A shared workspace for your collections operations.' },
  { icon: Building2, title: 'Finance teams', text: 'Review payment matches, unresolved items and daily close reports.' },
  { icon: ClipboardList, title: 'Operations teams', text: 'Track mandate activation and tasks that need attention.' },
];

/** Product sections are static: visiting the landing page never creates a workspace. */
export function LandingSections({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <section id="what" className="lp-section lp-jobs-section" aria-labelledby="what-title">
        <div className="public-container">
          <div className="lp-section-intro lp-split-intro">
            <p className="lp-section-kicker">Less chasing. More clarity.</p>
            <h2 id="what-title">Four collections tasks, one workspace</h2>
            <p>Your loan software creates mandates and requests debits when payments are due. Valo Pay brings the records together so your team can track, review and follow up.</p>
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
            <p>Start by reviewing records. Enable collection instructions only when the required agreements and controls are in place.</p>
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
            <h2 id="boundaries-title">What Valo Pay does,<br /> and where it stops</h2>
            <p>See how Valo Pay fits into your collections process, what it costs and where its responsibilities end.</p>
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
              <p className="lp-section-kicker">Explore before you sign in</p>
              <h2 id="cta-title">Try it with sample data</h2>
              <p>Explore two sample lenders, review outstanding tasks and run the daily close to check payment records. Sign in to keep your workspace between visits.</p>
            </div>
            <div className="lp-cta-controls">
              <div className="lp-cta-actions">
                <Button asChild size="lg" className="lp-cta-button"><Link href="/overview">Open the sandbox <ArrowUpRight aria-hidden="true" /></Link></Button>
                {!signedIn && <Button asChild size="lg" variant="ghost" className="lp-cta-signin"><Link href="/sign-in">Sign in <ArrowRight aria-hidden="true" /></Link></Button>}
              </div>
              <span className="lp-cta-note"><span aria-hidden="true" /> No sign-in needed. Sample data only.</span>
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
          <nav aria-label="Help and documentation" className="lp-footer-links"><a href="https://github.com/obeidpeter/valo-pay#readme">How the sandbox works</a><a href="https://github.com/obeidpeter/valo-pay/blob/main/docs/DATABASE_SECURITY.md">Security and data access</a><Link href="/sign-in">Sign in</Link></nav>
        </div>
        <div className="lp-footer-bottom"><p>Valo Pay · Collections operations layer · We never hold money.</p><div className="lp-footer-location"><span>Built for collections in Nigeria.</span><span className="lp-nigerian-flag" aria-hidden="true" /></div></div>
      </div>
    </footer>
  );
}
