import { useEffect } from 'react';
import { Link } from 'wouter';
import { ArrowRight, ChartNoAxesColumnIncreasing, Check, Link2, ShieldCheck, Waypoints } from 'lucide-react';
import { BrandLockup, BrandMark } from '@/components/brand';
import { LandingFooter, LandingSections } from '@/components/landing-sections';
import { Button } from '@/components/ui/button';
import { authEnabled, useSessionUser } from '@/lib/auth';
import '@/public-pages.css';
import '@/landing.css';

/** Static, explicitly synthetic illustration. Reading this page never creates a workspace. */
function CollectionsIllustration() {
  return (
    <figure className="lp-illustration" aria-label="Daily close example using sample data">
      <div className="lp-artwork">
        <div className="lp-art-glow" aria-hidden="true" />
        <div className="lp-orbit lp-orbit-outer" aria-hidden="true" />
        <div className="lp-orbit lp-orbit-middle" aria-hidden="true" />
        <div className="lp-orbit lp-orbit-inner" aria-hidden="true" />
        <div className="lp-art-dots" aria-hidden="true" />
        <div className="lp-sphere lp-sphere-one" aria-hidden="true" />
        <div className="lp-sphere lp-sphere-two" aria-hidden="true" />
        <div className="lp-sphere lp-sphere-three" aria-hidden="true" />
        <div className="lp-glass-sheet lp-glass-sheet-back" aria-hidden="true" />
        <div className="lp-glass-sheet lp-glass-sheet-middle" aria-hidden="true" />
        <div className="lp-brand-card" aria-hidden="true">
          <BrandMark className="lp-art-mark" />
          <span className="lp-art-name">Valo Pay</span>
          <span className="lp-art-tagline">Collections. Clarity. Control.</span>
        </div>
        <div className="lp-float-card lp-float-matched">
          <span className="lp-art-number">1,240</span>
          <span className="lp-art-label">Payments matched</span>
          <span className="lp-art-success"><Check aria-hidden="true" /> Close complete</span>
        </div>
        <div className="lp-float-card lp-float-reconciled">
          <ShieldCheck className="lp-art-icon" aria-hidden="true" />
          <span className="lp-art-title">Clear payment<br />matching</span>
          <span className="lp-art-label">See which instalment each payment covers.</span>
        </div>
        <div className="lp-float-card lp-float-decisions">
          <ChartNoAxesColumnIncreasing className="lp-art-icon" aria-hidden="true" />
          <span className="lp-art-title">Retry decisions<br />recorded</span>
          <span className="lp-art-inline-number">18 <span>in this sample</span></span>
        </div>
        <div className="lp-float-card lp-float-timeline">
          <Waypoints className="lp-art-icon" aria-hidden="true" />
          <span className="lp-art-title">One clear<br />timeline</span>
          <span className="lp-art-label">From consent<br />to collection.</span>
        </div>
      </div>
      <span className="lp-hero-note" aria-hidden="true">A clearer close.<br />A brighter morning.</span>
      <figcaption>Illustration with synthetic figures. These are sample records, not live results.</figcaption>
    </figure>
  );
}

export default function LandingPage() {
  const { userId } = useSessionUser();
  useEffect(() => { document.title = 'Valo Pay · Collections operations layer'; }, []);
  const signedIn = authEnabled && Boolean(userId);

  return (
    <div className="public-site landing-site min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to main content</a>
      <header className="public-header lp-header">
        <div className="public-container lp-header-inner">
          <BrandLockup />
          <nav aria-label="Sections" className="lp-header-nav">
            <a href="#what">What it does</a>
            <a href="#how">How it works</a>
            <a href="#boundaries">Our boundaries</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="lp-header-actions">
            <Button asChild variant="outline" size="sm" className="lp-header-sandbox"><Link href="/overview">Open the sandbox</Link></Button>
            {signedIn
              ? <Button asChild size="sm"><Link href="/overview"><span className="lp-workspace-label">Open your workspace</span><span className="lp-workspace-short" aria-hidden="true">Workspace</span></Link></Button>
              : <Button asChild size="sm"><Link href="/sign-in">Sign in</Link></Button>}
          </div>
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
