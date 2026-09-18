import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';

/**
 * The two kinds of notice the console raises after an action, and nothing
 * else. A "done" notice confirms what happened and where its result is; it
 * is announced politely and goes away on its own after a moment, pausing
 * while pointed at or focused. A "problem" notice says what did not happen
 * and what to do; it is announced at once and stays until dismissed,
 * because an error that disappears before it is read is no error message
 * at all. Anything whose result is shown on the page itself gets no notice
 * (Nielsen 1, 3, 8 and 9; Shneiderman: informative feedback; universal
 * design: perceptible information, low physical effort).
 */
export const DONE_DURATION_MS = 6000;

export type NoticeAction = { label: string; altText: string; onClick: () => void };

export function notifyDone(title: string, description?: string, action?: NoticeAction) {
  return toast({
    title,
    description,
    type: 'background',
    duration: DONE_DURATION_MS,
    action: action ? <ToastAction altText={action.altText} onClick={action.onClick}>{action.label}</ToastAction> : undefined,
  });
}

export function notifyProblem(title: string, description?: string) {
  return toast({ title, description, variant: 'destructive', type: 'foreground', duration: Infinity });
}

/** The words the server gave, or a plain fallback; never an HTTP status line. */
export function saidBy(error: unknown, fallback: string): string {
  const said = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof said === 'string' && said.trim() ? said.trim() : fallback;
}
