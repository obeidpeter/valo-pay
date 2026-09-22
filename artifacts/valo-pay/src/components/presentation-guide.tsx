import { createContext, useContext, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { ArrowRight, Presentation, X } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { presentationChecks, presentationSteps } from '@/lib/presentation';
import { Button } from './ui/button';

type Rehearsal = { active: boolean; step: number; checked: string[] };
const initial = (): Rehearsal => ({ active: false, step: 0, checked: [] });
function read(key: string): Rehearsal {
  try {
    const v = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (v && typeof v.active === 'boolean' && Number.isInteger(v.step) && v.step >= 0 && v.step < presentationSteps.length && Array.isArray(v.checked)) {
      return { active: v.active, step: v.step, checked: presentationChecks.filter(c => v.checked.includes(c.id)).map(c => c.id) };
    }
  } catch { /* Rehearsal controls also work without browser storage. */ }
  return initial();
}
const Context = createContext<{ state: Rehearsal; save: (next: Rehearsal) => void } | null>(null);
export function PresentationProvider({ children }: { children: ReactNode }) {
  const { workspace, merchantId } = useWorkspace();
  const scope = JSON.stringify([workspace?.viewerScope || workspace?.actor || 'anonymous', merchantId]);
  const storageKey = `valopay-presentation-v1:${scope}`;
  const [stored, setStored] = useState(() => ({ key: storageKey, value: read(storageKey) }));
  // Reset only this optional guide when the viewer/lender changes. Remounting
  // the console here would discard forms and uncertain-request recovery state.
  let state = stored.value;
  if (stored.key !== storageKey) {
    state = read(storageKey);
    setStored({ key: storageKey, value: state });
  }
  function save(next: Rehearsal) {
    setStored({ key: storageKey, value: next });
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* In-memory progress remains available. */ }
  }
  return <Context.Provider value={{ state, save }}>{children}</Context.Provider>;
}
export function usePresentation() {
  const context = useContext(Context);
  if (!context) throw new Error('Presentation controls need their provider.');
  return context;
}

export function PresentationGuide() {
  const { state, save } = usePresentation();
  const { workspace } = useWorkspace();
  if (!state.active || workspace?.environment !== 'sandbox') return null;
  const step = presentationSteps[state.step];
  return <section aria-label="Presentation guide" className="mb-5 rounded-xl border border-primary/25 bg-card p-4 print:hidden">
    <div className="flex flex-wrap items-center gap-3">
      <Presentation className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1"><p className="text-xs font-medium text-muted-foreground">Presentation · Sample data only</p><p className="mt-1 text-sm font-semibold" aria-live="polite">{state.step + 1} of {presentationSteps.length} · {step.title}</p></div>
      <Button asChild size="sm"><Link href={step.href}>{step.action}<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Link></Button>
      <Button variant="ghost" size="sm" onClick={() => save({ ...state, active: false })}><X className="mr-1 h-4 w-4" aria-hidden="true" />End presentation</Button>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
      <label htmlFor="presentation-step" className="text-xs font-medium">Talking point</label>
      <select id="presentation-step" className="min-h-9 max-w-full rounded-md border bg-background px-2 text-sm" value={state.step} onChange={e => save({ ...state, step: Number(e.target.value) })}>
        {presentationSteps.map((s, i) => <option key={s.href} value={i}>{i + 1}. {s.title}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={state.step === presentationSteps.length - 1} onClick={() => save({ ...state, step: state.step + 1 })}>Next talking point</Button>
      <Link href="/presentation" className="ml-auto inline-flex min-h-9 items-center text-sm text-primary underline underline-offset-4">Presentation preparation</Link>
    </div>
    <details key={state.step} className="mt-3 text-sm"><summary className="min-h-9 cursor-pointer py-2 font-medium">Show presenter notes (visible on this screen)</summary><p className="mt-2">{step.show}</p><p className="mt-2 text-muted-foreground">Say: {step.say}</p><p className="mt-2 text-muted-foreground">If needed: {step.fallback}</p></details>
  </section>;
}
