import { amountUnitName } from '@workspace/valopay-schema';
import { PRESENTATION_CUSTOMER, PRESENTATION_INSTALMENT, presentationChecks, presentationSteps } from './presentation';

/*
 * The presenter's brief and the sample pack, which only the Presentation page
 * offers for download. They live apart from the talking points, which the
 * guide on every console page reads, so the page shell does not carry them.
 */

export function presentationSamples(date: string) {
  return [
    { kind: 'Customers', filename: '01-presentation-customers.csv', csv: 'source_row_id,name,reference,consentProvenance,bankName,accountMasked\npres-c001,Presentation customer,PRES-C001,Synthetic presentation consent,Sandbox Bank,•••• 0001' },
    { kind: 'Instalments', filename: '02-presentation-instalments.csv', csv: `source_row_id,name,reference,customerId,amount,dueDate,owner\npres-d001,Presentation instalment,PRES-D001,PRES-C001,18000.50,${date},lms` },
    { kind: 'Payment evidence', filename: '03-presentation-payment.csv', csv: 'source_row_id,name,reference,customerId,amount,source,dueItemId,narration\npres-o001,Presentation payment,PRES-O001,PRES-C001,18000.50,statement,PRES-D001,PRES-D001 synthetic transfer' },
  ];
}

/** The pack's naira amounts as Import batches names their unit: payment evidence calls it by its row's currency too. */
export const sampleAmountUnit = `under Amounts in the source file, ${amountUnitName('naira', 'due-items')}, or ${amountUnitName('naira', 'observations')} for Payment evidence`;

export function presenterBrief(date: string): string {
  return `# Valo Pay presenter brief\n\nPrepared for ${date} (WAT). Suggested demonstration: six minutes.\n\n## Opening\n\nValo Pay helps lender teams connect payment evidence, resolve exceptions and review the daily close. This demonstration uses synthetic records; no money moves.\n\n## Before the meeting\n\n${presentationChecks.map(c => `- [ ] ${c.label}`).join('\n')}\n\n## Prepare the sample import\n\nUse one sample lender in an isolated rehearsal workspace. Import Customers, then Instalments before the meeting; import Payment evidence during the demonstration. In Import batches choose the matching record type and, ${sampleAmountUnit}; use source name “Presentation sample”, source row column “source_row_id” and a distinct file reference for each CSV. Use the pack’s date (${date}) as its business date. Save and check each batch, inspect the amount, then commit once. Expected instalment and receipt: exactly ₦18,000.50 each. Reconciliation is a separate action. Once it runs, rule R1 matches the payment to ${PRESENTATION_INSTALMENT} automatically and with certainty, because the payment names that instalment and the amounts are equal. The match never appears in Matches to review; its rule and explanation are in the sample customer’s history (Customers, search ${PRESENTATION_CUSTOMER}, View history).\n\nStable source row IDs protect repeat imports; repeating the same file is not a reset. For a fresh rehearsal use a separate anonymous browser profile/private session or a new empty synthetic lender, with appropriate access. A new empty lender has no seeded exceptions: prepare a case or demonstrate the absence honestly. Never clear an existing workspace.\n\n## Demonstration\n\n${presentationSteps.map((s,i) => `### ${i + 1}. ${s.title} · ${s.time}\n\nOpen: ${s.href}\n\nShow: ${s.show}\n\nSay: “${s.say}”\n\nIf needed: ${s.fallback}`).join('\n\n')}\n\n## Questions to prepare for\n\n- Who is it for? Start with lender Operations and Finance teams handling payment reconciliation and exceptions.\n- What is working? Demonstrate the saved records, checks, decisions and exports actually available in this build.\n- Is Paystack connected? The test adapter and local scenarios are implemented. An external connection has not been verified; do not claim payment acceptance or Direct Debit availability.\n- Is it production-ready? Real staff identity/MFA, managed keys, restricted database access, recovery and external services still require host verification and the agreed acceptance process.\n- Does this prove traction or recovery uplift? No. Bring separately verified customer conversations, agreements and measured pilot results, if available.\n- What will investment enable? Explain your actual hiring, commissioning and pilot plan. Do not invent an amount, timeline, customer count or return.\n\n## If something fails\n\nExplain the actual state. For an uncertain write, inspect Operations before resubmitting; use the existing recovery action. For a pending export, inspect Saved exports. Continue with a prepared screenshot or recording and label it as recorded. Do not disable controls to finish the story.\n\n## Closing\n\nThe next milestone is a controlled lender pilot that measures operator completion, errors and time to close. Ask for feedback on the workflow and introductions to relevant lender teams.\n`;
}

export function downloadPresentationFile(filename: string, content: string, csv = false) {
  const url = URL.createObjectURL(new Blob([csv ? '\uFEFF' : '', content], { type: csv ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
