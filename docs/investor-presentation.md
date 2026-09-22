# Investor presentation preparation

Open **Presentation** in the console navigation. This page adds a six-minute demonstration sequence, a downloadable Markdown presenter brief, three synthetic CSV files and a personal preparation checklist. It is presentation support, not evidence of production acceptance or an investor pitch containing verified commercial results.

## Prepare once, rehearse before the meeting

1. Confirm the intended release is deployed and that you can open its Presentation page. A merged pull request alone does not establish the host version.
2. Use a separate anonymous browser profile or private session for an isolated, seeded synthetic workspace. Choose one lender. Verify the actual permissions needed for the actions you will show. Do not use real customer records or alter access merely to complete the demonstration.
3. Download the presenter brief and the three CSV files. Import Customers and then Instalments before the meeting. In Import batches choose the corresponding record type, Naira, source name “Presentation sample”, source row column “source_row_id”, a distinct source file reference for each file and the business date printed on the Presentation page. Save and check each file, review the preview and commit once.
4. Prepare the Payment evidence batch for the meeting. Both the instalment and receipt are exactly ₦18,000.50; the customer reference is PRES-C001. Commit the payment once when demonstrating it, then run reconciliation separately if permitted. A matching record may be automatic or require review; explain the actual result.
5. Inspect a seeded open exception and its case history before presenting. It is a separate case, not an invented consequence of the sample payment. Prepare a daily close and inspect its actual source coverage and Finance review state. Missing sources, pending review and independent approval requirements remain visible. Merely switching demo roles is not independent approval.
6. Generate and download a sample customer dispute pack in advance. Keep the file and a short labelled recording or screenshots available if the connection fails. Keep backups within the approved synthetic demonstration workspace.

The three CSV files have stable source identities. A repeated import is not a reset; duplicate detection should preserve the original records. For a new rehearsal use a new anonymous session or a new empty synthetic lender, with the appropriate access. Empty lenders have no seeded exceptions or close history until prepared. Do not delete an existing workspace to restart a demo.

## Six-minute sequence

| Time | Screen | Point to demonstrate |
| --- | --- | --- |
| 45 seconds | Overview | One lender’s outstanding work and actual sample metrics. |
| 60 seconds | Import batches | Validation, exact naira amounts and saved source provenance. |
| 90 seconds | Reconciliation | Why a payment matches an obligation; uncertainty remains review work. |
| 60 seconds | Exceptions and case history | Ownership, deadlines, next action and handover context. |
| 60 seconds | Reports and Close review | Recorded close, source coverage and independent review are separate states. |
| 45 seconds | Saved exports | Ready evidence can be retrieved; pending or failed generation stays explicit. |

Start presentation guide keeps a compact toolbar across console pages. Select a talking point and use its Open link; advancing a talking point does not run an action, navigate away from unsaved work or mark a task complete. Notes are collapsed by default and are visible to anyone viewing the shared screen when expanded. End presentation removes the toolbar. Other navigation, environment labels and the normal permission checks remain available.

Preparation checks are self-reported, retained in session storage for the viewer and lender. They survive a page reload, are separate for other lenders, and fall back to memory if storage is unavailable. Clear preparation checks only clears these checkboxes. No readiness status or platform record is changed.

## Claims and questions

Say: “This is a working platform demonstrated with synthetic records. We are preparing controlled lender pilots. External provider verification and production commissioning remain outstanding.”

Demonstrate the behaviour available in the current build. Do not treat a sample amount, completed checklist, local Paystack fixture or passing automated test as customer traction, recovered revenue, regulatory approval or a commissioned external service. Explain that the Paystack test adapter is prepared but its external connection has not been verified. Real identity/MFA, managed keys, restricted database access, recovery and live acceptance require verification on the intended host.

Bring separately verified customer conversations, agreements, pricing assumptions and pilot results if available. Prepare the actual funding request and spending plan separately; this feature does not supply or invent them. Keep the core collections-to-close journey central and use other modules only when a specific question calls for them.

If a request’s outcome is uncertain, inspect Operations and use its existing recovery action before submitting again. If an export is pending, show that state and use the previously downloaded sample. Label a backup recording as recorded. Do not disable controls to make a failed step appear successful.

## Verification boundary

Console tests cover guide persistence and lender separation, malformed or unavailable session storage, the absence of operational writes from presentation controls, and the sample files through the actual batch/domain functions. Browser checks cover the guide, file downloads, keyboard-accessible controls, light/dark contrast and narrow screens. These are development checks; rehearse the deployed build before the meeting.
