# Valo Pay content guide

Use this guide whenever you write or change words in Valo Pay. That covers screens, messages, borrower pages, error pages, exports and accessible names. It turns the product documents into rules for writing. Where a rule comes from a source document, the reference is given in brackets.

## Sources of truth

| Source | Use it for |
|---|---|
| Business Plan | Positioning: Valo Pay is software that runs a lender's collections back office. It never holds money; each lender connects its own Paystack account. |
| Product Roadmap | Release boundaries: Collections and Pay-by-bank are v1. Credit Desk and Cash Desk are later and gated, and stay as demo previews until then. |
| Technical Requirements Document (TRD) | Meanings: states (7, 8.3), roles (4), business rules (BR-01 to BR-22), customer pages (8.2, FR-CP1, FR-CP2) |
| Brochure (September 2026) | Current public wording. Its illustrations do not prove that a feature works. |

Before you write a claim, check what the code actually does. When the sources, the code and the screen disagree, record it in [copy-review.md](copy-review.md) and name who decides. Do not settle it by writing a confident sentence.

## Voice

Professional, calm, respectful, direct and human. Write for a first-time collections officer or cooperative desk officer, and keep the detail a reviewer, finance team or auditor needs.

- Each message answers what happened, what it means and what the person can do next.
- Name the actor when it matters: your bank, Paystack, the lender (by name), a reviewer, Valo Pay.
- No hype, filler or blame. Do not use: "Kindly", "Please be advised", "seamless", "leverage", "Something went wrong", "Invalid input", "Action required", "Operation unsuccessful".
- On staff screens, use "please" only when it softens a real request. Clarity is what makes writing respectful.

## Style

- **Spelling:** British and Nigerian English: organisation, authorise, authorisation, instalment, cancelled, licence (noun).
- **Capitals:** sentence case for headings, buttons, labels, table headings and filters. Keep the canonical names as written: Dashboard, Customers, Collections, Pay-by-bank, Reviews, Reports, Settings & team, Credit Desk, Cash Desk, Paystack, Admin, Preparer, Reviewer, Viewer.
- **Buttons and links:** start with a verb and say exactly what happens, for example Create payment request, Copy link, Request refund, Put on hold, Release hold, Withdraw consent, Close loan, Record decision.
  - Never use Submit, OK or Click here.
  - Use **Cancel** only to stop something that has not finished, such as cancelling a payment request or leaving a form. Never use it for withdrawing, rejecting, refunding or deleting.
- **Punctuation:** no full stop in headings, buttons, labels or table headings. Use full stops in sentences, including one-sentence messages. Use "·" to separate metadata.
- **Contractions:** avoid negative contractions (write "cannot", "do not", "is not"). Positive ones (you're, we've) are fine.
- **Money:** ₦ with thousands separators and two decimals, for example ₦35,000.00. Wording never changes a stored amount.
- **Dates and times:** 3 Oct 2026 (TRD NFR-09). Times are 24-hour, West Africa Time. Add "WAT" on detail pages, borrower pages and anywhere a deadline or expiry decides what someone can do.
- **Numbers and plurals:** use numerals. Make every count agree with its noun ("1 instalment", "2 instalments").
- **Abbreviations:** spell out on first use where a first-time user meets them, for example Bank Verification Number (BVN). CSV, ID, PDF and VAT need no explanation.

## Words to use

| Use | Meaning | Avoid |
|---|---|---|
| **organisation** | The lender or cooperative that uses Valo Pay | client, company, tenant |
| **customer** (staff screens) | The borrower or cooperative member whose loans the organisation manages (TRD 4.1) | borrower, debtor, user |
| **the lender's name** (borrower pages) | Who the customer deals with, for example "Meridian Finance". Do not assume every organisation is a "lender": use its name. | "the organisation", "Valo Pay" |
| **loan**, **loan ID** | A loan, and the organisation's own ID for it | loan reference (in labels), loan id |
| **customer ID** | The organisation's own ID for a customer | external ID |
| **instalment** | One scheduled repayment amount and its due date | invoice, bill, transaction |
| **consent** | The customer's permission for the lender to debit their bank account to collect instalments for one loan, up to a maximum amount per debit, until an end date. Also called a direct-debit mandate; introduce that term only when needed. | mandate on its own, approval |
| **consent link** | The link a customer opens to give consent | consent request (for the link) |
| **authorise**, **authorisation** | What the customer does at their bank to give consent | approve (for consent) |
| **approve at their bank** | What the customer does to pay a Pay-by-bank request | authorise (for one-off payments), confirm |
| **payment request** | A request asking a customer to pay one instalment. Creating or sharing it never means money was received. | payment (until confirmed), send payment |
| **payment link** | The link inside a payment request | demo link, request link |
| **payment** | Money a provider has confirmed, or a sample record in the demo | collection (for a single payment) |
| **Pay-by-bank** | A one-off bank payment for one instalment. Hyphenated, capital P. | pay by bank, pay by transfer |
| **direct debit** | Collecting an instalment under active consent | auto-debit |
| **Dashboard** | The team's home screen at /: what is due today, what was confirmed and what needs a decision. Called Today in TRD 8.1; renamed by the owner (D16). | Today (as a screen name), home, overview |
| **today's debits**, **Run today's debits** | The direct debits for instalments due today. In the live service they run by themselves each morning; in the demo a person starts the run on sample data. | auto-collect, sweep, batch |
| **payment matching** | Linking a confirmed payment to the instalment it covers. Keep confirmed, suggested and reviewed matches distinct. | reconciliation (for one payment) |
| **review** | A staff decision on an item in the review queue. Never use it for the customer approving at their bank or giving consent. | approval (unless the decision is to approve or reject) |
| **hold**, **on hold** | A pause that stops new payment requests and debits for a loan or instalment | pause (as a noun), freeze, "Hold" as a badge |
| **refund request** | A request to return part or all of a confirmed payment. Steps: Requested → Approved or Rejected → Processing → Refunded or Failed. | refunded (before the Refunded state) |
| **Paystack account**, **Paystack connection** | The organisation's own Paystack account and Valo Pay's connection to it | bank connection, payment gateway |
| **eligible debit** | A confirmed direct debit whose reversal period has passed without a reversal; only these carry the usage fee (BR-16, BR-17) | every confirmed payment |
| **customer credit** (planned) | A record of an excess payment waiting to be allocated to an instalment. Not money Valo Pay holds. | wallet, balance |
| **two-step verification** | The second step when signing in (FR-X1.2) | 2FA, two-factor authentication |
| **sign in** | | log in, login |
| **demo** | This environment: sample data, no live connections (TRD 10.3) | sandbox (in the TRD, Sandbox is the mode that uses Paystack test keys) |
| **sample data** | Made-up records in the demo | synthetic data, dummy data |
| **acting as** | The team member a demo visitor is playing. The demo has no sign-in. | signed in as, logged in as, simulating |

## Roles

Keep the four role names (TRD R3) and explain them wherever someone chooses a role or is blocked by one:

- **Admin:** sets up the organisation, team and settings; can also act as a Reviewer.
- **Preparer:** collections officer. Imports loans, creates consent links and payment requests, requests refunds and works the review queue.
- **Reviewer:** supervisor. Approves or rejects refunds, decides items that affect money and releases holds.
- **Viewer:** read-only access and downloads.

The rule that the person who prepared an item cannot decide it (BR-11) always names the person ("You prepared this item…"), not a role.

## States: keep the label, explain the meaning

Show the TRD label exactly (TRD 8.3), and add a plain explanation wherever a decision depends on it. Never merge states into Done, Successful, Pending or Problem.

| Object | States |
|---|---|
| Instalment | Upcoming, Due, Paid, Part-paid, Overdue, Failed, Unknown, In progress; **On hold** is a flag on top |
| Consent | Not requested, Requested, Awaiting bank, Active, Withdrawn, Expired, Failed |
| Payment request | Awaiting approval (the customer has not yet approved the payment at their bank), Awaiting confirmation, Confirmed, Failed, Unknown, Expired, Cancelled |
| Refund | Requested, Approved, Rejected, Processing, Refunded, Failed |
| Review | Open, In progress, Resolved, Dismissed |
| Loan | Open, Closed |

Rules that protect financial meaning:

- **Confirmed** is not sent, submitted or awaiting confirmation. A payment is Confirmed only when Valo Pay has verified it with the provider; a return from the bank page is not proof of payment (BR-02, BR-03).
- **Unknown** is not Failed: "There is no final result yet. Further collection for this instalment is on hold." A browser or network problem is never described as Unknown.
- **Review types** keep their TRD name in the data and in CSV exports. On screen, show the plain name from `REVIEW_LABEL` where there is one, with its one-line meaning from `REVIEW_HINT`. The owner chose **Payment result not known** for the review type Unknown result (copy-review.md, O15). In sentences, say "has no final result yet" or "whether this payment went through", not "has an Unknown result".
- **Active** consent does not mean money can be collected now. Debits still follow the schedule, the maximum per debit, the six-hour wait and the notice rule (BR-07, BR-09).
- **Approved** (refund) is not **Refunded**. Never tell anyone money has been returned until the provider reports Refunded.
- A link **expiring** is not a payment **failing**.
- A payment is not its **allocation** to an instalment.
- A **forecast** is an estimate; a **balance** is a recorded figure.
- Records from an uploaded statement are reviewed by staff, not verified by Paystack.

## Borrower pages

Borrowers should never need to understand Valo Pay's internal terms.

- Write to the customer as "you". Put the lender's name first and describe Valo Pay only as "service provider to {lender}" (FR-CP1).
- Show only first name, amount, instalment, lender and loan reference (FR-CP2). On the consent page, also show the schedule, maximum per debit, end date, what happens if a debit does not go through, and how to withdraw (TRD 8.2).
- On the consent page, list only instalments that can still be collected. Never show paid or past dates under "the dates below". On the payment page, do not say the amount settles the instalment: it can be part of it.
- Do not use "we": it could mean the lender or Valo Pay.
- When a result is pending or unclear, explain it and do not suggest paying again.
- No urgency, shame or threats. No promises about timing, delivery or safety ("your money is safe", "you have not been charged").

## Messages

- **Success:** say what was done to what, and the consequence. Example: "Payment request cancelled. The link no longer works."
- **Errors:** give the reason and a safe next step, without blame. Do not suggest repeating an action that moves money until its outcome is known.
- **Blocked actions:** give the real reason and the permitted next step. Never suggest a way round a safeguard.
- **Actions by role:** show a button or link only to roles that can use it. Where a role cannot act, say who can ("An Admin or Preparer can …").
- **Empty states:** tell apart no records yet, no matches for a search or filter, no permission, and data that is unavailable. Offer only actions the person can take.
- **Notifications:** never claim a message was sent, delivered or received unless the system did it. Queued is not sent; sent is not delivered.

## Legal, consent and evidence text

- Do not change the meaning of consent statements, withdrawal terms, fee conditions, retention periods, privacy or security notices. Put proposed wording in [copy-review.md](copy-review.md) for the owner to decide.
- Make no integrity or security claim, such as "tamper-proof" or "changes can be detected", unless the system enforces and checks it. The security owner approves that wording.
- Never rewrite audit entries, decision notes, imported narrations or other saved records. Change only the labels and explanations around them, and the wording of future messages.
- Pages hosted by Paystack or a bank are outside Valo Pay. Do not describe them as if Valo Pay controls their wording.

## Before you ship a copy change

1. The words match what the code does in that state, for that role.
2. Terms come from the table above, and the same thing has the same name everywhere.
3. Buttons say what will happen; confirmations and messages describe the same event.
4. Amounts, dates, recipients and conditions are still there.
5. Visible labels match accessible names, and status is never shown by colour alone.
6. `uv run pytest` passes, including the copy checks in `core/tests/test_copy.py`.
