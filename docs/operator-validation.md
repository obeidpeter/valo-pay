# Operator validation

This is a prepared study, not evidence of completed user research. No lender operators have been observed yet. Automated checks and synthetic performance measurements do not establish that the product is easy for its intended users.

## Arrange a session

Start with five people who perform collections work: two Operations staff, two Finance staff and one Compliance reviewer. This is a small formative study to find problems, not a statistically representative benchmark. Use their usual desktop or laptop, and include a keyboard-only pass where it matches how a participant works. Reserve about 40 minutes per person.

Use an isolated synthetic workspace for each participant. Record a participant code, role, build revision, device, browser and date; do not record names or actual borrower information. Ask for consent before any recording and agree retention with the participant. A facilitator may take de-identified notes instead. No invitations or recordings are sent automatically.

Prepare a fresh workspace, the facilitator's expected outcomes, and a synthetic CSV containing a payment observation for ₦18,000.50. Its amount cell must be `18000.50`, and its column should be named `amount`; use a unique synthetic reference. Do not put any real customer information in the file. Also prepare a file containing one extra decimal place to exercise error correction. Run the study on the new build, then repeat affected tasks after any fixes using different equivalent fixtures.

## Opening script

“We are testing Valo Pay, not you. These are made-up records and no money moves. Work as you normally would and say what you are looking for or expecting. You can stop at any time. I will mostly watch rather than explain the interface. If you get stuck, tell me what you would do next.”

## Tasks to read aloud

Give one task at a time without naming buttons or the sequence of screens. Do not show the facilitator notes until the participant has finished.

| Task | Scenario | Facilitator success criteria |
| --- | --- | --- |
| Find and return | You are working through customers at Zenith Bank. Find Chiamaka Obi, investigate her payment history, then return to the same list to continue your work. | Identifies the right customer and payment context, returns with the same search/page, and can identify the row just visited. |
| Import an amount | You received this synthetic receipt file. Its values are in naira. Add it to the workspace and tell me the amount you expect to see afterwards. | Explicitly chooses naira, checks the preview, identifies ₦18,000.50, imports once and verifies the result. No factor-of-100 error. |
| Correct an import | This second file contains a value that needs correction. Work out what is wrong and show how you would fix it without importing an incorrect batch. | Explains the precision error, corrects it, rechecks, and understands that nothing was imported while errors remained. |
| Investigate unmatched money | A receipt has no confirmed payer. Decide what you can establish from the records and what needs to happen next. | Distinguishes received evidence from an allocation, identifies missing evidence, and keeps the payment unallocated if the payer cannot be established. Completing this task does not require confirming a match. |
| Explain a close | Your manager asks whether today's books are complete. Establish what has run, what remains unresolved and which evidence you would show. | Distinguishes no close, completed close and outstanding exceptions; states the observed status without claiming that synthetic evidence proves live readiness. |
| Prepare evidence | A colleague needs the customer's dispute evidence. Prepare it and explain how you would obtain it if generation is interrupted. | Starts one export, recognises its saved status, downloads the ready result, and can identify how to resume or retry. For failure observation use a controlled test environment; never interrupt production services. |
| Understand access | In the supplied read-only or reviewer persona, assess whether you can add a customer or approve the supplied submission, and explain who can act. | Understands the displayed role requirement and independent-review restriction without filling a form that cannot be submitted. |

## Record results

For each task, record: unassisted success, assisted success, failed or stopped; elapsed time; observable errors; assistance given; the participant's explanation; and an ease rating from 1 (very difficult) to 7 (very easy). Start timing after reading the task and stop when the participant believes they have finished. Confirm the resulting state separately. Mark interrupted tasks rather than treating them as slow completions.

An error is an observable incorrect interpretation or action, not a pause, different navigation preference or facilitator guess. Keep critical errors separate: wrong customer, incorrect amount, unsupported allocation, or misunderstanding whether an export is available. Record the exact behaviour and result; do not infer motives. If help was needed, the outcome is assisted even if the task eventually succeeds.

Report the denominator for every metric. Calculate unassisted completion as unassisted successes divided by attempted, non-interrupted tasks. Report median completion time for unassisted successes separately from assisted and failed tasks. Report critical errors and assistance counts alongside the small-sample percentages. Compare like roles, tasks and fixtures; a small study does not justify population-wide claims.

Fix any wrong-money or wrong-customer interpretation before a pilot. Prioritise other findings by consequence, frequency and recoverability, assign an owner, and retest with new equivalent tasks. Keep untested recommendations and observed findings separate. A facilitator rehearsal can check the script but must not be reported as a session with a lender operator.

The task format follows [Nielsen Norman Group's guidance on realistic, actionable task scenarios](https://www.nngroup.com/articles/task-scenarios-usability-testing/).

## Commissioning dependencies

The configuration inspection on 18 September 2026 confirmed healthy public liveness/readiness checks, with the scheduler intentionally off. It found no Paystack test credentials, outbound email service or verified sender, or managed key provider. A separate staging identity application and independent recovery resources/storage-backup access were not verified. Existing managed sign-in and App Storage do not establish these separate resources.

The alert destination is the address configured in `VALOPAY_ALERT_TO` on the host. Complete email delivery and inbox receipt verification using the procedure in [operational rehearsals](operational-rehearsals.md). Supply the Paystack test key through host secrets and run the existing test-only read-only connection check described in [Paystack setup](paystack.md). Never substitute a live key or paste credentials into a study result, pull request or conversation.

Use the separate identity, restricted database and key-provider procedures in [pilot security](pilot-security.md) and [pilot database recovery](pilot-database.md). Agree recovery objectives with the pilot owner, then verify database, private objects, retained keys and access roles together in an independent restore environment. Record actual measurements and failures. These services and participant sessions cannot be completed by changing application source alone.
