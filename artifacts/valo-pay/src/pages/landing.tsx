import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ArrowDownLeft, ArrowRight, Check, Clock3, Link2, Menu, ShieldCheck, Waypoints, X } from 'lucide-react';
import { BrandLockup, BrandMark } from '@/components/brand';
import { LandingFooter, LandingSections } from '@/components/landing-sections';
import { Button } from '@/components/ui/button';
import { authEnabled, useSessionUser } from '@/lib/auth';
import { useHashTarget } from '@/lib/use-hash-target';
import '@/public-pages.css';
import '@/landing.css';

const landingTargets = ['main', 'what', 'how', 'boundaries', 'pricing', 'pilot', 'product-tour'];
const sectionLinks = [
  { href: '#what', label: 'What it does' },
  { href: '#product-tour', label: 'Product tour' },
  { href: '#how', label: 'How it works' },
  { href: '#boundaries', label: 'Our boundaries' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#pilot', label: 'Discuss a pilot' },
];

/** Static, explicitly synthetic illustration. Reading this page never creates a workspace. */
function CollectionsIllustration() {
  return (
    <figure className="lp-illustration" aria-label="Payment reconciliation example using sample data">
      <div className="lp-preview">
        <div className="lp-preview-heading">
          <span className="lp-preview-brand"><BrandMark aria-hidden="true" /> Valo Pay <span>/ Collections</span></span>
          <span className="lp-preview-sample">Sample data</span>
        </div>
        <div className="lp-preview-summary">
          <div className="lp-preview-summary-top">
            <span className="lp-preview-kicker">Reconciliation snapshot</span>
            <span className="lp-preview-emblem" aria-hidden="true"><ArrowDownLeft /></span>
          </div>
          <span className="lp-preview-total">₦67,000<span>.00</span></span>
          <span className="lp-preview-total-label">Matched to customer instalments</span>
          <div className="lp-preview-counts">
            <span><Check aria-hidden="true" /> 2 payments matched</span>
            <span><Clock3 aria-hidden="true" /> 1 needs review</span>
          </div>
        </div>
        <div className="lp-preview-activity">
          <div className="lp-preview-section-label"><span>Payment activity</span><span>Amount · NGN</span></div>
          <ul className="lp-preview-payments" aria-label="Sample payment activity">
            <li>
              <span className="lp-preview-avatar" aria-hidden="true">AO</span>
              <div className="lp-preview-person"><span>Ada Okonkwo</span><span>Instalment 1</span></div>
              <div className="lp-preview-payment"><span>₦42,000</span><span className="lp-preview-matched"><Check aria-hidden="true" /> Matched</span></div>
            </li>
            <li>
              <span className="lp-preview-avatar" aria-hidden="true">TB</span>
              <div className="lp-preview-person"><span>Túndé Bakare</span><span>Instalment 2</span></div>
              <div className="lp-preview-payment"><span>₦25,000</span><span className="lp-preview-matched"><Check aria-hidden="true" /> Matched</span></div>
            </li>
            <li>
              <span className="lp-preview-avatar lp-preview-avatar-review" aria-hidden="true">CO</span>
              <div className="lp-preview-person"><span>Chiamaka Obi</span><span>Proposed match · Instalment 3</span></div>
              <div className="lp-preview-payment"><span>₦18,000</span><span className="lp-preview-review"><Clock3 aria-hidden="true" /> Needs review</span></div>
            </li>
          </ul>
        </div>
        <div className="lp-preview-footer">
          <Waypoints aria-hidden="true" />
          <span>Every payment. A clear next step.</span>
        </div>
      </div>
      <div className="lp-preview-workflow" role="group" aria-label="The matching workflow">
        <span><span>01</span> Receive</span><ArrowRight aria-hidden="true" />
        <span><span>02</span> Match</span><ArrowRight aria-hidden="true" />
        <span><span>03</span> Record</span>
      </div>
      <figcaption>Illustration with synthetic figures. These are sample records, not live results.</figcaption>
    </figure>
  );
}

export default function LandingPage() {
  const { userId } = useSessionUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useHashTarget(landingTargets, true);
  useEffect(() => { document.title = 'Valo Pay · Collections operations layer'; }, []);
  const signedIn = authEnabled && Boolean(userId);

  return (
    <div className="public-site landing-site min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to main content</a>
      <header className="public-header lp-header" onKeyDown={(event) => {
        if (event.key === 'Escape' && menuOpen) {
          setMenuOpen(false);
          menuButton.current?.focus();
        }
      }}>
        <div className="public-container lp-header-inner">
          <BrandLockup href="#main" />
          <nav aria-label="Sections" className="lp-header-nav">
            {sectionLinks.map((link) => <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>{link.label}<ArrowRight aria-hidden="true" /></a>)}
          </nav>
          <div className="lp-header-actions">
            <Button asChild variant="outline" size="sm" className="lp-header-sandbox"><Link href="/overview">Open the sandbox</Link></Button>
            {signedIn
              ? <Button asChild size="sm"><Link href="/overview"><span className="lp-workspace-label">Open your workspace</span><span className="lp-workspace-short" aria-hidden="true">Workspace</span></Link></Button>
              : <Button asChild size="sm"><Link href="/sign-in">Sign in</Link></Button>}
            <Button ref={menuButton} variant="outline" size="icon" className="lp-menu-toggle" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="landing-navigation" onClick={() => setMenuOpen(!menuOpen)}>
              {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            </Button>
          </div>
          {menuOpen && <nav id="landing-navigation" aria-label="Mobile sections" className="lp-mobile-nav">
            {sectionLinks.map((link) => <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>{link.label}<ArrowRight aria-hidden="true" /></a>)}
          </nav>}
        </div>
      </header>

      <main id="main" tabIndex={-1} className="focus:outline-none">
        <section className="lp-hero-section" aria-labelledby="hero-title">
          <svg className="lp-hero-contours" viewBox="0 0 1440 760" fill="none" preserveAspectRatio="none" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((line) => <path key={line} d={`M-100 ${570 + line * 20} C140 ${610 + line * 22},180 ${805 + line * 14},460 800 M1050 ${-150 + line * 28} C1210 ${-35 + line * 28},1260 ${290 + line * 24},1500 ${80 + line * 23}`} />)}
          </svg>
          <div className="public-container lp-hero">
            <div className="lp-hero-copy">
              {/* Descriptor, promise and custody boundary are the first three content lines. */}
              <p className="lp-eyebrow">A collections operations layer for lenders that collect by direct debit</p>
              <h1 id="hero-title">Know what was paid, what is due, <span>and what needs attention.</span></h1>
              <p className="lp-hero-description">We never hold money. Valo Pay connects to your payment provider and loan software. Track mandate activation, review retries, match payments to instalments and keep one clear record for each customer.</p>
              <div className="lp-hero-actions">
                <Button asChild size="lg" className="lp-primary"><Link href="/overview">Open the sandbox <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
                <Button asChild size="lg" variant="outline"><a href="#how">See how it works</a></Button>
              </div>
              <p className="lp-sandbox-hint">No sign-in needed. Explore with sample data; no live collection instructions are sent.</p>
              <ul className="lp-hero-benefits" aria-label="Built for your workflow">
                <li><Link2 aria-hidden="true" /><span>Works with your<br /> existing systems</span></li>
                <li><ShieldCheck aria-hidden="true" /><span>Retry rules<br /> you control</span></li>
                <li><Waypoints aria-hidden="true" /><span>One clear<br /> customer record</span></li>
              </ul>
              <p className="lp-stage"><span aria-hidden="true" /> Sandbox · Sample data only · No live collections</p>
            </div>
            <CollectionsIllustration />
          </div>
        </section>
        <LandingSections signedIn={signedIn} />
      </main>
      <LandingFooter />
    </div>
  );
}
