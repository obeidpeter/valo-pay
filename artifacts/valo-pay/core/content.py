"""Explanations of stored demo states; not claims of provider verification."""
STATE_HELP = {
    "Unknown": "No final result is known. Do not retry; authoritative evidence is required.",
    "Confirmed": "A stored confirmed record. Synthetic examples are not evidence of real money received.",
    "Awaiting approval": "The request is awaiting approval. A link is not a completed payment.",
    "Awaiting confirmation": "The outcome is still being checked. Do not pay again.",
    "Failed": "A failure is recorded. Check earlier attempts before considering a retry.",
    "On hold": "Further collection is paused. Independent approval and evidence gates still apply.",
    "Active": "Consent is recorded as active. This demo cannot perform bank debits.",
    "Awaiting bank": "Bank activation is pending in the stored sample state; no provider is connected.",
    "Requested": "A request is recorded, not an executed payment or bank authorisation.",
    "Withdrawn": "The stored consent or unused link is withdrawn; this is not proof of provider deactivation.",
    "Expired": "This item is no longer available. Expiry does not settle earlier payment attempts.",
    "Cancelled": "No further action through this request. Cancellation is not payment reconciliation.",
    "Refunded": "A refund is recorded. This demo cannot send a real refund.",
    "Reversed": "A reversal is recorded. Reconcile the balance before taking another action.",
}

# Guide-only wording; keep shared status help in other journeys unchanged.
GUIDE_STATE_HELP = {
    "Unknown": "The payment result is not clear. Do not try again; collection stays on hold until there is a verified result from the bank or payment service.",
    "Confirmed": "The record shows a successful payment.",
    "Awaiting approval": "The request is waiting to be accepted. Opening its link does not complete a payment.",
    "Awaiting confirmation": "The payment result is still being checked. Do not pay again.",
    "Failed": "A failure is recorded. Check earlier attempts before deciding what to do; do not retry automatically.",
    "On hold": "Collection is paused. A separate reviewer must check before it resumes, and any required bank or payment-service result must be verified.",
    "Active": "Permission to collect payments is active in the record.",
    "Awaiting bank": "Waiting for the bank to activate permission to collect payments.",
    "Requested": "A request has been saved. This does not confirm a payment or permission to collect it.",
    "Withdrawn": "The customer’s permission or unused link is no longer active in these records. This does not confirm that the bank has cancelled permission to take payments.",
    "Expired": "The link or request is no longer available. An earlier payment attempt may still need checking.",
    "Cancelled": "This request cannot be used again. Cancellation does not tell you the result of an earlier payment attempt.",
    "Refunded": "The record shows money returned to the customer.",
    "Reversed": "A payment that was previously Confirmed is recorded as undone. Check the amount still owed before taking another action.",
}