# Paystack test adapter

Status: **adapter and durable test inbox tested offline; external account connection not verified**. No Paystack account or test key is available. The optional signed test ingress remains disabled until an operator configures a test key and a server-only workspace/lender mapping. All debit instructions remain disabled. See [pilot operations controls](pilot-operations-controls.md) for fixtures, duplicate receipts, conflict quarantine and the exact raw-byte ingress boundary.

## What is implemented

`artifacts/api-server/src/providers/paystack.ts` is a reusable, read-only test adapter. It accepts only `sk_test_` credentials, uses the fixed `https://api.paystack.co` origin, refuses redirects, bounds a request and response read to 10 seconds by default (15 seconds maximum), and limits response bodies to 256 KiB. Errors contain fixed messages, never provider payloads, authorisation headers, keys or nested transport errors.

- Connection check: authenticated `GET /transaction?perPage=1&page=1`; returns no transaction details.
- Transaction verification: requires an expected reference, positive integer kobo amount and NGN currency. A caller checking Direct Debit must additionally request the `direct_debit` channel. A successful HTTP request alone is not a successful payment.
- Mandate verification: checks an existing test mandate reference and returns only its state and an authorisation fingerprint. Raw authorisation codes never leave the adapter.
- Webhook parsing: verifies HMAC-SHA512 over the original bytes, with constant-time digest comparison, before parsing JSON. Payment events must explicitly say `domain: test`; any declared non-test domain is refused. Mandate events may omit domain as in Paystack's documented payload and must still carry a signature made with the configured test key.
- Unknown-outcome recovery: verifies the original reference once. Timeouts, unavailable responses, rate limits and references not yet found remain unknown. It never issues a debit, changes the reference or automatically reissues an instruction.

The read endpoints and response fields follow Paystack's [Transaction API](https://paystack.com/docs/api/transaction/). Signature handling follows its [webhook documentation](https://paystack.com/docs/payments/webhooks/).

## Direct Debit availability is not assumed

Paystack documents Direct Debit for Nigerian businesses, with authorisation creation and activation as separate states. Its Direct Debit documentation does not establish whether this account can use the feature in test mode, and the Test Payments guide does not provide a Direct Debit test recipe. A general test-key connection therefore reports `directDebitAvailability: unconfirmed`. Obtain Paystack confirmation or verify an existing, correctly identified test Direct Debit mandate/transaction before reporting that capability as observed. A card or ordinary bank test transaction is not Direct Debit evidence. Sources: [Direct Debit](https://paystack.com/docs/payments/direct-debit/), [Test Payments](https://paystack.com/docs/payments/test-payments/).

An observed test mandate verifies only that reference and state. It does not prove production activation, settlement, retry permissions, bank coverage or launch readiness.

## Operator verification

Supply `PAYSTACK_TEST_SECRET_KEY` securely in the operator process environment. Do not put the key in source, command arguments, screenshots, tickets or browser code. The checker does not edit environment files or application configuration.

From the repository root:

```sh
pnpm run check:paystack
```

To verify an existing test payment against its expected amount (in kobo), add:

```sh
pnpm run check:paystack -- --reference TEST_REFERENCE --amount-kobo 100000 --direct-debit
```

To inspect an existing test mandate without creating or charging one:

```sh
pnpm run check:paystack -- --mandate-reference TEST_MANDATE_REFERENCE
```

The checker prints only safe check results and states. It never prints the secret, transaction reference, amount, customer details, authorisation code or full provider response. Exit 0 means the requested read checks succeeded; it does not mark the Valo Pay integration connected. Missing or rejected credentials and failed/mismatched checks exit 1.

## Applying evidence later

`parsePaystackTestWebhook` authenticates and normalises a candidate; it does not apply money or persist a receipt. `verifyPaymentWebhook` additionally fetches authoritative transaction status and checks the expected payment and provider transaction identity. Bind the expected payment to the lender and provider connection from trusted server storage, never from a webhook's metadata or a caller-supplied tenant ID.

Before enabling ingestion, implement durable tenant-to-connection/key binding and an inbox receipt with a unique `(tenant, connection, dedupeKey)` constraint. Persist the receipt, state change and audit entry atomically. Acknowledge only a durable receipt, then process it asynchronously; retain an explicit retry/manual-review state after failures. The dedupe key remains the same for repeated deliveries even if JSON formatting changes. A raw-body hash alone is insufficient for deduplication.

Use `reconcilePaystackEvidence` with the previously persisted verified payment under the same lock/transaction. Identical verified evidence is a duplicate; a pending result cannot roll back a completed state; conflicting identity or terminal evidence requires review. A verified reversal is explicit evidence, not an inferred consequence of a timeout. `reconcilePaystackMandateEvidence` likewise prevents a late authorisation-created event from rolling an active mandate back to pending. Durable persistence and locking remain requirements of the future ingestion service.

No public ingestion endpoint, persistent receipt store, mandate initialisation, charge dispatch, production credential support or automatic retry dispatcher is introduced here. Those require the remaining access, storage, tenant-binding and operational gates.

## Offline verification

`artifacts/api-server/tests/paystack.test.ts` exercises the adapter with injected responses and signed synthetic bytes. It covers valid and mismatched payments, live-mode refusal, tampering, repeated and reordered deliveries, conflicting and stale evidence, timeout recovery using the original reference, key/redirect restrictions, response limits and redacted failures. No test calls Paystack or needs a key.

Documentation checked against the official pages on 18 September 2026. Provider behaviour observed with real test credentials must be recorded separately from these offline checks.
