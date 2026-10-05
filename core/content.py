"""Plain-language explanations shown next to the documented labels (docs/content/content-guide.md).

The labels themselves (statuses, review types, roles) come from the TRD and are stored as data; these
sentences only explain them. Change the meaning here only with the product owner.
"""

# Consent states (TRD 7.4, BR-07, BR-09), for staff.
CONSENT = {
    "Not requested": "No consent link has been created for this loan yet.",
    "Requested": "A consent link has been created. The customer has not authorised it yet. The link works for 14 days.",
    "Awaiting bank": "The customer has authorised, and their bank is still activating the consent. No debit can be made until it is Active.",
    "Active": "Consent is in place. Debits must still follow the schedule, the maximum per debit, the six-hour wait after authorisation and the notice rule.",
    "Withdrawn": "The consent, or a consent link the customer had not used, was withdrawn. No debits can be made under it.",
    "Expired": "This consent is no longer valid: its end date passed or the link was not used within 14 days.",
    "Failed": "The consent was not activated, for example because the bank reported a problem.",
}

# Payment request states (FR-P2.1, BR-02, BR-05), for staff.
PAYMENT_REQUEST = {
    "Awaiting approval": "The customer has not yet approved this payment at their bank.",
    "Awaiting confirmation": "The customer has finished at their bank. The payment is not confirmed until it is verified with Paystack.",
    "Confirmed": "The payment was verified with Paystack and linked to the instalment.",
    "Failed": "Paystack reported that this payment did not go through.",
    "Unknown": "There is no final result for this payment yet. Further collection for this instalment is on hold until it is resolved.",
    "Expired": "The link expired before a payment was approved. It no longer works.",
    "Cancelled": "This request was cancelled. The link no longer works.",
}

# Review types (FR-C5.1): what is being reviewed and why it needs a person.
REVIEW_KIND = {
    "Unknown result": "We do not know yet whether this payment went through. Collection for this instalment stays on hold until the result is known.",
    "Unclear match": "A payment may belong to this instalment, but it could not be matched automatically. Someone must confirm or reject the suggested match.",
    "Possible duplicate": "Two payments may cover the same instalment. Someone must decide whether one of them should be refunded.",
    "Non-retryable failure": "A debit did not go through for a reason that trying again will not fix, such as a closed account or withdrawn consent.",
    "Consent problem": "Something is wrong with this customer's consent and a person needs to look at it.",
    "Refund request": "A team member has asked to return part or all of a confirmed payment.",
    "Reversal": "A confirmed payment was reversed by the bank, so the instalment is open again.",
}

# Review types as staff read them. The TRD name stays in the data and in CSV exports; the owner asked for plain
# words on screen for "Unknown result" (copy-review.md, demo walk-through of 5 Oct 2026).
REVIEW_LABEL = {"Unknown result": "Payment result not known"}

# One-line explanations under each item on the Dashboard.
REVIEW_HINT = {
    "Unknown result": "We do not know yet if this payment went through.",
    "Unclear match": "A payment may belong here, but it could not be matched automatically.",
    "Possible duplicate": "Two payments may cover the same instalment.",
    "Non-retryable failure": "A debit failed, and trying again will not fix it.",
    "Consent problem": "Something is wrong with the customer's consent.",
    "Refund request": "A team member asked to return money to a customer.",
    "Reversal": "The bank reversed a confirmed payment.",
}

# Why the direct-debit run leaves an instalment alone, in plain words (FR-C3, BR-02, BR-05, BR-07).
CONSENT_NOT_ACTIVE = {
    "Not requested": "there is no consent for this loan yet",
    "Requested": "the customer has not given consent yet",
    "Awaiting bank": "the customer's bank has not activated the consent yet",
    "Withdrawn": "the customer withdrew consent",
    "Expired": "the consent has expired",
    "Failed": "the consent was not activated",
}

# Roles (TRD 4.1).
ROLE = {
    "Admin": "Sets up the organisation, team and settings. Can also act as a Reviewer.",
    "Preparer": "Collections officer: imports loans, creates consent links and payment requests, requests refunds and works the review queue.",
    "Reviewer": "Supervisor: approves or rejects refunds, decides items that affect money and releases holds.",
    "Viewer": "Read-only access and downloads.",
}

# Retry presets (FR-C3.3, BR-08) as the customer reads them on the consent page. Legal owner to approve.
RETRY_FOR_CUSTOMER = {
    "Standard": "{lender} may try again 2 days later and 5 days later, for the same amount.",
    "Gentle": "{lender} may try once more, 3 days later, for the same amount.",
    "Off": "{lender} will not try again automatically.",
}
