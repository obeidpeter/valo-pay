import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowRight, BookOpen, Check, X } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { Button } from './ui/button';

const steps = [
  { title: 'Inspect a customer', href: '/customers', action: 'Open customers', instruction: 'Choose a sample customer and open their timeline.', outcome: 'You can trace their mandate, instalment, payment and consent in one place.' },
  { title: 'Review a payment match', href: '/reconciliation?view=review', action: 'Review proposed matches', instruction: 'Compare a proposed payment with its instalment. Check the explanation before confirming or rejecting it. If the queue is empty, inspect an existing match instead.', outcome: 'You understand why the records match and what your decision changes.' },
  { title: 'Resolve an exception', href: '/exceptions?view=overdue', action: 'Review overdue exceptions', instruction: 'Open an exception, check the customer and deadline, then record the appropriate resolution and a reason. If no items are overdue, switch to All open.', outcome: 'The item moves to Resolved and its decision remains in the audit log.' },
  { title: 'Run a daily close', href: '/reports#daily-closes', action: 'Open daily close', instruction: 'Select Run daily close in Reports. Wait for the result, then inspect the new daily close record.', outcome: 'A dated summary shows the reconciliation results and anything still unresolved.' },
  { title: 'Download a customer report', href: '/customers', action: 'Open a customer timeline', instruction: 'Choose a customer, then select Export dispute pack (PDF). Open the generated file and check its summary and timeline.', outcome: 'You have a sample report with a checksum. It is not evidence of a real collection.' },
];

type Progress = { step: number; hidden: boolean; complete: boolean };
const initial: Progress = { step: 0, hidden: false, complete: false };
function readProgress(key: string): Progress {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < steps.length && typeof saved.hidden === 'boolean' && typeof saved.complete === 'boolean') return saved;
  } catch { /* The guide also works when browser storage is unavailable. */ }
  return { ...initial };
}

/** A voluntary, per-lender learning checklist. Completion is local, never operational evidence. */
export function SandboxGuide() {
  const { merchantId, workspace } = useWorkspace();
  const [location] = useLocation();
  const key = `valopay-guide-v1:${merchantId}`;
  const [progress, setProgress] = useState<Progress>(() => readProgress(key));
  useEffect(() => { setProgress(readProgress(key)); }, [key]);
  if (!merchantId || !workspace || workspace.environment !== 'sandbox') return null;
  function save(next: Progress) {
    setProgress(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Session-only progress is sufficient. */ }
  }
  if (progress.hidden) return location === '/overview' ? (
    <div className="mb-4 print:hidden"><Button size="sm" variant="ghost" className="gap-2" onClick={() => save({ ...progress, hidden: false })}><BookOpen className="h-4 w-4" aria-hidden="true" />{progress.complete ? 'Review sandbox guide' : 'Open sandbox guide'}</Button></div>
  ) : null;
  const step = steps[progress.step]!;
  return (
    <section aria-label="Sandbox guide" className="mb-6 rounded-xl border border-primary/20 bg-card p-4 sm:p-5 print:hidden">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your first five steps</p><h2 aria-live="polite" className="mt-1 font-semibold">{progress.complete ? 'You have explored the core workflow' : step.title}</h2></div>
        <Button size="icon" variant="ghost" aria-label="Dismiss sandbox guide" onClick={() => save({ ...progress, hidden: true })}><X aria-hidden="true" className="h-4 w-4" /></Button>
      </div>
      {progress.complete ? <>
        <p className="mt-2 text-sm text-muted-foreground">Your checklist is complete. This records your own progress in this browser; it does not confirm that operational tasks or readiness checks passed.</p>
        <Button className="mt-3" variant="outline" size="sm" onClick={() => save({ ...initial })}>Restart guide</Button>
      </> : <>
        <p className="mt-2 text-sm text-muted-foreground">{step.instruction}</p>
        <p className="mt-2 text-sm"><span className="font-medium">What to look for: </span>{step.outcome}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button asChild size="sm" className="gap-2"><Link href={step.href}>{step.action}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
          <Button variant="outline" size="sm" onClick={() => save({ ...progress, step: Math.min(progress.step + 1, steps.length - 1), complete: progress.step === steps.length - 1 })}><Check className="mr-1 h-4 w-4" aria-hidden="true" />I've completed this step</Button>
          {progress.step > 0 && <Button variant="ghost" size="sm" onClick={() => save({ ...progress, step: progress.step - 1 })}>Previous step</Button>}
          <span className="text-xs text-muted-foreground">Step {progress.step + 1} of {steps.length} · Sample data only</span>
        </div>
      </>}
    </section>
  );
}
