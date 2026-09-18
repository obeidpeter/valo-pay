import { useState } from 'react';
import { Link } from 'wouter';
import { ArrowUpRight, CirclePlay, Mail } from 'lucide-react';
import { Button } from './ui/button';

const screens = [
  { name: 'Overview', path: '/overview', title: 'Start with the work that needs attention', description: 'See unpaid instalments, proposed matches and overdue exceptions, then open the relevant queue.' },
  { name: 'Payment matching', path: '/reconciliation?view=review', title: 'Understand a match before you confirm it', description: 'Compare payment evidence with the instalment and see the effect of your decision.' },
  { name: 'Daily close', path: '/reports#daily-closes', title: 'Finish with a clear, dated record', description: 'Review reconciliation results, unresolved items and the records created by each daily close.' },
];
export const PILOT_EMAIL = 'obeidpeter1@gmail.com';
export const PILOT_CONTACT = `mailto:${PILOT_EMAIL}?subject=${encodeURIComponent('Valo Pay pilot enquiry')}&body=${encodeURIComponent('Hello, I would like to discuss a Valo Pay pilot.\n\nOrganisation:\nMy role:\nCurrent payment provider and loan software:\nApproximate monthly collection volume:\n\nPlease do not include customer records, bank details or credentials.')}`;

/** Uses the actual console, loaded only after an explicit choice; no decorative mock data or autoplay. */
export function ProductWalkthrough() {
  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  const screen = screens[active]!;
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  const [path, hash] = screen.path.split('#');
  const source = `${basePath}${path}${path!.includes('?') ? '&' : '?'}embedded=1${hash ? `#${hash}` : ''}`;
  return (
    <section id="product-tour" className="lp-section lp-product-tour" aria-labelledby="product-tour-title">
      <div className="public-container">
        <div className="lp-section-intro"><p className="lp-section-kicker">See the product in action</p><h2 id="product-tour-title">A working day in Valo Pay</h2><p>Explore the actual console with sample data. The preview starts only when you choose to open it.</p></div>
        <div className="lp-tour-tabs" role="group" aria-label="Choose a product screen">
          {screens.map((item, index) => <Button key={item.name} variant={index === active ? 'default' : 'outline'} aria-pressed={active === index} onClick={() => setActive(index)}>{String(index + 1).padStart(2, '0')} · {item.name}</Button>)}
        </div>
        <div className="lp-tour-copy"><div><h3>{screen.title}</h3><p>{screen.description}</p></div><Button asChild variant="outline" size="sm"><Link href={screen.path}>Open full screen <ArrowUpRight aria-hidden="true" className="ml-1 h-4 w-4" /></Link></Button></div>
        <div className="lp-tour-frame">
          {started ? <iframe key={source} src={source} title={`Interactive Valo Pay ${screen.name.toLowerCase()} preview — sample data`} loading="lazy" /> : <div className="lp-tour-placeholder"><CirclePlay aria-hidden="true" /><p>Use the real screens, with sample records.</p><Button onClick={() => setStarted(true)}>Load interactive preview</Button><span>This opens a sandbox in your browser. No live collection instructions are sent.</span></div>}
        </div>
        {started && <p className="lp-tour-footnote">Interactive sandbox · Changes affect your sample workspace. On small screens, scroll within the preview or open it full screen.</p>}
      </div>
    </section>
  );
}

export function PilotEnquiry() {
  return <section id="pilot" className="lp-section lp-pilot" aria-labelledby="pilot-title"><div className="public-container lp-pilot-inner"><div><p className="lp-section-kicker">Plan your pilot</p><h2 id="pilot-title">See how Valo Pay fits your team.</h2><p>Tell us about your collections workflow, payment provider and loan software. We’ll discuss the scope and requirements for a pilot.</p><p className="lp-pilot-note">Please keep customer records, bank details and credentials out of your enquiry.</p></div><div className="lp-pilot-actions"><Button asChild size="lg"><a href={PILOT_CONTACT}><Mail aria-hidden="true" className="mr-2 h-4 w-4" /> Discuss a pilot</a></Button><a href={`mailto:${PILOT_EMAIL}`}>{PILOT_EMAIL}</a><span>Opens your email app</span></div></div></section>;
}
