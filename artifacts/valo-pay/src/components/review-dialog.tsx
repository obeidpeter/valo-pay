import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateRecord } from '@workspace/api-client-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FieldError, FormAlert, focusField, invalidProps } from '@/components/form-field';
import { useWorkspace } from '@/lib/workspace-context';
import { notifyDone, saidBy } from '@/lib/notify';

export const reviewJobs = [
  { value: 'mandates', label: 'Mandate operations' },
  { value: 'retries', label: 'Retries' },
  { value: 'reconciliation', label: 'Payment matching' },
  { value: 'audit', label: 'Audit and dispute records' },
] as const;

/** Records the tasks actually checked; a count cannot establish which tasks were reviewed. */
export function ReviewDialog({ onClose }: { onClose: () => void }) {
  const { merchantId, workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [reviewer, setReviewer] = useState(workspace?.actor || '');
  const [reviewedAt, setReviewedAt] = useState('');
  const [confirmedJobs, setConfirmedJobs] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const todayInWAT = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  const create = useCreateRecord({ mutation: {
    onSuccess: () => {
      void queryClient.invalidateQueries();
      notifyDone('Review recorded', `${confirmedJobs.length} of 4 tasks confirmed. Sample reviews do not establish live readiness.`);
      onClose();
    },
    onError: (error: unknown) => setFailure(saidBy(error, 'The review was not saved. Try again.')),
  } });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!reviewer.trim()) next.reviewer = 'Enter the reviewer’s name.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) || Number.isNaN(Date.parse(reviewedAt)) || new Date(reviewedAt).toISOString().slice(0, 10) !== reviewedAt) next.reviewedAt = 'Choose the date the review took place.';
    else if (reviewedAt > todayInWAT) next.reviewedAt = 'The review date cannot be in the future.';
    if (!note.trim()) next.note = 'Describe what was checked and any tasks still outstanding.';
    setErrors(next); setFailure('');
    const first = ['reviewer', 'reviewedAt', 'note'].find(key => next[key]);
    if (first) { focusField(`review-${first}`); return; }
    if (!merchantId) return;
    create.mutate({ kind: 'reviews', params: { merchantId }, data: {
      name: `Operational review · ${reviewedAt}`, status: 'recorded',
      data: { reviewer: reviewer.trim(), reviewedAt, confirmedJobs, note: note.trim() },
    } });
  };
  return (
    <Dialog open onOpenChange={open => { if (!open && !create.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log fortnightly review</DialogTitle>
          <DialogDescription>Record what was checked with sample data. Only a review confirming all four tasks counts towards the review schedule.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-5">
          {(failure || Object.keys(errors).length > 0) && <FormAlert title="Review not saved">{failure || 'Check the highlighted fields.'}</FormAlert>}
          <div className="space-y-1.5">
            <label htmlFor="review-reviewer" className="text-sm font-medium">Reviewer name</label>
            <input id="review-reviewer" required {...invalidProps('review-reviewer', errors.reviewer)} value={reviewer} onChange={event => setReviewer(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
            <FieldError id="review-reviewer" message={errors.reviewer} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="review-reviewedAt" className="text-sm font-medium">Review date</label>
            <input id="review-reviewedAt" required {...invalidProps('review-reviewedAt', errors.reviewedAt)} type="date" max={todayInWAT} value={reviewedAt} onChange={event => setReviewedAt(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
            <FieldError id="review-reviewedAt" message={errors.reviewedAt} />
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Tasks confirmed</legend>
            {reviewJobs.map(job => <label key={job.value} className="flex min-h-10 items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <input type="checkbox" checked={confirmedJobs.includes(job.value)} onChange={event => setConfirmedJobs(previous => event.target.checked ? [...previous, job.value] : previous.filter(value => value !== job.value))} />
              {job.label}
            </label>)}
            <p className="text-xs text-muted-foreground">{confirmedJobs.length} of 4 confirmed. You can save a partial review and describe the remaining work below.</p>
          </fieldset>
          <div className="space-y-1.5">
            <label htmlFor="review-note" className="text-sm font-medium">Review notes</label>
            <textarea id="review-note" required {...invalidProps('review-note', errors.note)} value={note} onChange={event => setNote(event.target.value)} rows={3} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
            <FieldError id="review-note" message={errors.note} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>Cancel</Button>
            <Button type="submit" busy={create.isPending} busyLabel="Saving review…">Save review</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
