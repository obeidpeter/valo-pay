import { useRef, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, ArrowUpRight, CirclePlay, FileCheck, LayoutDashboard, Mail, Waypoints } from 'lucide-react';
import { Button } from './ui/button';

const screens = [
  { name: 'Overview', icon: LayoutDashboard, hint: 'Find your next task', path: '/overview', title: 'Start with the work that needs attention', description: 'See unpaid instalments, proposed matches and overdue exceptions, then open the relevant queue.' },
  { name: 'Payment matching', icon: Waypoints, hint: 'Review the evidence', path: '/reconciliation?view=review', title: 'Understand a match before you confirm it', description: 'Compare payment evidence with the instalment and see the effect of your decision.' },
  { name: 'Daily close', icon: FileCheck, hint: 'Keep a dated record', path: '/reports#daily-closes', title: 'Finish with a clear, dated record', description: 'Review reconciliation results, unresolved items and the records created by each daily close.' },
];
export const PILOT_EMAIL = 'obeidpeter1@gmail.com';
export const PILOT_CONTACT = `mailto:${PILOT_EMAIL}?subject=${encodeURIComponent('Valo Pay pilot enquiry')}&body=${encodeURIComponent('Hello, I would like to discuss a Valo Pay pilot.\n\nOrganisation:\nMy role:\nCurrent payment provider and loan software:\nApproximate monthly collection volume:\n\nPlease do not include customer records, bank details or credentials.')}`;

/** Uses the actual console, loaded only after an explicit choice; no decorative mock data or autoplay. */
export function ProductWalkthrough() {
  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadButton = useRef<HTMLButtonElement>(null);
  const closePreview = () => {
    setStarted(false);
    setLoaded(false);
    requestAnimationFrame(() => loadButton.current?.focus());
  };
  const screen = screens[active]!;
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  const [path, hash] = screen.path.split('#');
  const source = `${basePath}${path}${path!.includes('?') ? '&' : '?'}embedded=1${hash ? `#${hash}` : ''}`;
  return (
    <section id="product-tour" className="lp-section lp-product-tour" aria-labelledby="product-tour-title">
      <div className="public-container">
        <div className="lp-section-intro lp-split-intro"><p className="lp-section-kicker">Take a closer look</p><h2 id="product-tour-title">A working day in Valo Pay</h2><p>From the first task to the daily close. Choose a screen, then try the actual console with sample data.</p></div>
        <div className="lp-tour-tabs" role="group" aria-label="Choose a product screen">
          {screens.map((item, index) => <button key={item.name} className="lp-tour-step" aria-pressed={active === index} aria-controls="tour-preview" onClick={() => { if (active !== index) { setLoaded(false); setActive(index); } }}><item.icon aria-hidden="true" /><span><span>{String(index + 1).padStart(2, '0')} · {item.name}</span><span>{item.hint}</span></span><ArrowRight aria-hidden="true" /></button>)}
        </div>
        <div id="tour-preview" className="lp-tour-shell">
          <div className="lp-tour-toolbar"><span><span aria-hidden="true" className="lp-tour-indicator" /> {started ? 'Interactive sandbox' : 'Explore the workspace'}</span><div>{started && <Button variant="ghost" size="sm" onClick={closePreview}>Close preview</Button>}<Button asChild variant="ghost" size="sm"><Link href={screen.path}>Open full screen <ArrowUpRight aria-hidden="true" className="ml-1 h-4 w-4" /></Link></Button></div></div>
          <div className="lp-tour-copy" aria-live="polite"><h3>{screen.title}</h3><p>{screen.description}</p></div>
          <div className="lp-tour-frame">
            {started ? <><p className="lp-tour-load-status" role="status">{loaded ? `${screen.name} preview loaded. Sample data only.` : 'Loading preview… You can also open it full screen.'}</p><iframe key={source} src={source} title={`Interactive Valo Pay ${screen.name.toLowerCase()} preview — sample data`} onLoad={() => setLoaded(true)} /></> : <div className="lp-tour-placeholder"><span className="lp-tour-play"><CirclePlay aria-hidden="true" /></span><p>Your next step starts here.</p><span>No sign-in needed. The preview opens only when you choose.</span><Button ref={loadButton} size="lg" onClick={() => setStarted(true)}>Load interactive preview <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" /></Button></div>}
          </div>
          <p className="lp-tour-footnote">Sample data only. No live collection instructions. {started ? 'Changes stay in your sample workspace after closing the preview. On a phone, open full screen for more room.' : 'Any changes you make in the preview stay in your sample workspace.'}</p>
        </div>
      </div>
    </section>
  );
}

export function PilotEnquiry() {
  return <section id="pilot" className="lp-section lp-pilot" aria-labelledby="pilot-title"><div className="public-container"><div className="lp-pilot-inner"><div><p className="lp-section-kicker">Plan your pilot</p><h2 id="pilot-title">See how Valo Pay fits your team.</h2><p>Tell us about your collections workflow, payment provider and loan software. We’ll discuss the scope and requirements for a pilot.</p><p className="lp-pilot-note">Please keep customer records, bank details and credentials out of your enquiry.</p></div><div className="lp-pilot-actions"><span className="lp-icon-tile"><Mail aria-hidden="true" /></span><h3>Let’s talk about your workflow</h3><Button asChild size="lg"><a href={PILOT_CONTACT}>Discuss a pilot <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" /></a></Button><a href={`mailto:${PILOT_EMAIL}`}>{PILOT_EMAIL}</a><span>Opens your email app</span></div></div></div></section>;
}
