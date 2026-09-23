import { normaliseRefundStatus, normaliseReversalStatus } from '@workspace/valopay-schema';

type ActingWorkspace = { role: string; actor: string } | undefined;
type PermissionRecord = { status?: string; data?: Record<string, unknown> } | null;
export type PermissionRequest = { action?: string; kind?: string; record?: PermissionRecord };

const operators = ['Admin', 'Operations', 'Finance'];
const recordRoles: Record<string, string[]> = {
  customers: operators, mandates: ['Admin', 'Operations'], 'due-items': operators,
  attempts: ['Admin', 'Operations'], observations: operators,
  policies: ['Admin'], templates: ['Admin'], experiments: ['Admin'], evidence: ['Admin'], cutovers: ['Admin'],
  commercial: ['Admin', 'Finance'], costs: ['Admin', 'Finance'], 'settlement-batches': ['Admin', 'Finance'],
  exceptions: [...operators, 'Compliance reviewer'], reviews: [...operators, 'Compliance reviewer'],
  calendar: ['Admin', 'Operations'],
};
const actionRoles: Record<string, string[]> = {
  kill_switch: ['Admin'], approve_kill_switch_off: ['Admin'], update_settings: ['Admin'], import_records: operators,
  mandate_suspend: ['Admin', 'Operations'], mandate_cancel: ['Admin', 'Operations'], mandate_reinstate: ['Admin', 'Operations'],
  mandate_reissue: ['Admin', 'Operations'], activation_reminder: ['Admin', 'Operations'],
  notify_policy_change: ['Admin', 'Operations'], apply_policy_version: ['Admin', 'Operations'],
  create_policy: ['Admin'], edit_policy: ['Admin'], submit_policy: ['Admin'], new_policy_version: ['Admin'],
  approve_policy: ['Compliance reviewer'], reject_policy: ['Compliance reviewer'],
  create_template: ['Admin'], edit_template: ['Admin'], submit_template: ['Admin'], new_template_version: ['Admin'],
  approve_template: ['Compliance reviewer'], reject_template: ['Compliance reviewer'],
  run_reconciliation: operators, daily_close: operators,
  confirm_allocation: ['Admin', 'Finance'], reject_allocation: ['Admin', 'Finance'], manual_allocate: ['Admin', 'Finance'],
  review_allocation: ['Admin', 'Finance'], record_refund: ['Admin', 'Finance'], issue_invoice: ['Admin', 'Finance'],
  edit_batch: ['Admin', 'Finance'], resolve_exception: operators,
  simulate_failure: ['Admin', 'Operations'], hand_back: ['Admin', 'Operations'],
  backtest_policy: [...operators, 'Compliance reviewer'], preregister_experiment: ['Admin'],
};

/** Presentation guard only. The server remains authoritative for every write. */
export function permissionReason(workspace: ActingWorkspace, { action, kind, record }: PermissionRequest): string | null {
  if (!action && !kind) return null;
  if (!workspace) return 'Wait for your workspace permissions to load.';
  const allowed = action ? actionRoles[action] : recordRoles[kind!];
  if (!allowed) return 'This action is unavailable for your role.';
  const roles = allowed.length < 2 ? allowed[0] : `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}`;
  if (!allowed.includes(workspace.role)) return `Requires ${roles}.`;
  if (['approve_policy', 'reject_policy', 'approve_template', 'reject_template'].includes(action || '') && record?.data?.author === workspace.actor) {
    return 'Ask a different Compliance reviewer. You cannot review your own submission.';
  }
  if (action === 'submit_template' && record?.data?.author !== workspace.actor) return 'Only this template’s author can submit it for review.';
  if ((['edit_template', 'edit_policy'].includes(action || '') || (!action && ['templates', 'policies'].includes(kind || ''))) && record?.data?.author && record.data.author !== workspace.actor) return 'Only this draft’s author can edit it.';
  // One refund is recorded per payment, even one that returned only part of it, and reversed money already went back.
  if (action === 'record_refund' && normaliseReversalStatus(record?.data?.reversalStatus) === 'reversed') return 'The provider reversed this payment, so its money already went back.';
  if (action === 'record_refund' && normaliseRefundStatus(record?.data?.refundStatus) === 'refunded') return 'A refund is already recorded for this payment.';
  if (!action && ['templates', 'policies'].includes(kind || '') && record && !['draft', 'rejected'].includes(record.status || '')) {
    return 'This submitted or approved version cannot be edited. Create a draft version to make changes.';
  }
  return null;
}
