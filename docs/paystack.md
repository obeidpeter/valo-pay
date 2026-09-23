# Paystack test adapter

Status: **adapter and durable test inbox tested offline; external account connection not verified**. No Paystack account or test key is available. The optional signed test ingress stays off until an operator configures a test key and a server-only workspace and lender mapping; [Signed test ingress](#signed-test-ingress) gives its address, configuration and answers. All debit instructions remain disabled. See [pilot operations controls](pilot-operations-controls.md) for fixtures, duplicate receipts and conflict quarantine.

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

The checker prints only safe check results and states. It never prints the secret, transaction reference, amount, customer details, authorisation code or full provider response. `webhookIngestion` (`disabled`, `test_only` or `misconfigured`) and `mappedConnections` (a count, never the IDs) report the ingress setting of the process the check runs in, so run it with the API's environment to see what the API would do. Exit 0 means the requested read checks succeeded; it does not mark the Valo Pay integration connected. Missing or rejected credentials and failed/mismatched checks exit 1.

## Signed test ingress

The API can save Paystack test events for a synthetic lender. The address is `POST /api/v1/providers/paystack/{connectionId}/events`, and it is off unless the API's environment has all three settings:

- `VALOPAY_PAYSTACK_INGRESS=test` turns it on. Unset or any other value answers 503.
- `PAYSTACK_TEST_SECRET_KEY` is the `sk_test_` key of the Paystack test account. The running API reads it only to check signatures, never to call Paystack.
- `VALOPAY_PAYSTACK_CONNECTIONS` maps each connection ID to one existing workspace and lender: `{"<connection ID>":{"workspaceId":"<workspace ID>","merchantId":"<lender ID>"}}`. A connection ID is 64 lower-case hexadecimal characters; make one with `openssl rand -hex 32`.

The mapped lender must be in sandbox or observation mode with its kill switch on. In the Paystack dashboard, under Settings, API Keys & Webhooks, register `https://<API host>/api/v1/providers/paystack/<connection ID>/events` as the test-mode webhook URL.

The signature authenticates a delivery, not the connection ID. The API checks the `x-paystack-signature` header, an HMAC-SHA512 of the exact request bytes under the test key, before it looks up the connection or locks, reads or decrypts anything. A forged or tampered delivery gets 401 and nothing else, whichever connection ID it names; only a verified event reaches the lender. Browser state, query strings and event fields never choose the lender.

The answers, in the order they are checked:

| Answer | When |
| --- | --- |
| 429 | More than 120 deliveries a minute from one client address. |
| 413 | The body is larger than 256 KiB. |
| 400 | The connection ID is malformed, or the body is not `application/json`. |
| 503 | The ingress is off, or the test key is missing or not an `sk_test_` key. |
| 401 | The signature is missing or does not match the exact bytes. Nothing was locked, read or saved. |
| 400 | The signed event is not JSON, is inconsistent, or comes from live mode. |
| 503 | The connection map is not valid. |
| 404 | No lender is mapped to the connection ID. |
| 503 | The lender is busy with another change. Paystack delivers the event again. A mapping whose lender no longer exists gets this answer too, on every delivery, so correct or remove such a mapping. |
| 403 | The mapping names another workspace, or the lender is not in sandbox or observation mode with its kill switch on. |
| 200 | `{"accepted":true,"duplicate":false}` when the event is saved, and `duplicate: true` for a repeat delivery of an event already saved. |

A verified event is saved in the mapped lender's inbox as a receipt, with the audit entry `paystack.test_event`, and appears in the Paystack test connection panel on the Sources page. `charge.success` waits for independent verification, and evidence that conflicts with an earlier receipt or the lender's saved expectation is quarantined. The two `direct_debit.authorization.*` events record mandate evidence only, and any other signed event is recorded as ignored. None of them creates a payment, allocation, debit or mandate authority.

## Applying evidence later

`parsePaystackTestWebhook` authenticates and normalises a candidate; it does not apply money. The signed test ingress saves each verified event as a receipt under the lender lock, with its audit entry, and acknowledges it only after the transaction commits. A repeat delivery is recognised under the same lock by its connection, event identity and payload digest, so the key stays the same even if JSON formatting changes; a raw-body hash alone would not be enough. The receipts carry no database unique constraint: the lender lock is what keeps them single. `verifyPaymentWebhook` additionally fetches authoritative transaction status and checks the expected payment and provider transaction identity; it is not yet run against the inbox's receipts. Bind the expected payment to the lender and provider connection from trusted server storage, never from a webhook's metadata or a caller-supplied tenant ID.

Use `reconcilePaystackEvidence` with the previously persisted verified payment under the same lock/transaction. Identical verified evidence is a duplicate; a pending result cannot roll back a completed state; conflicting identity or terminal evidence requires review. A verified reversal is explicit evidence, not an inferred consequence of a timeout. `reconcilePaystackMandateEvidence` likewise prevents a late authorisation-created event from rolling an active mandate back to pending. The inbox applies both to each received event under the lender lock, against the receipts already saved for the same connection.

Not yet introduced: verification of inbox receipts against Paystack, a database-held binding of connections and keys (the mapping and key live in the server environment), mandate initialisation, charge dispatch, production credential support and an automatic retry dispatcher. Those require the remaining access, storage, tenant-binding and operational gates.

## Offline verification

`artifacts/api-server/tests/paystack.test.ts` exercises the adapter with injected responses and signed synthetic bytes. It covers valid and mismatched payments, live-mode refusal, tampering, repeated and reordered deliveries, conflicting and stale evidence, timeout recovery using the original reference, key/redirect restrictions, response limits and redacted failures. `artifacts/api-server/tests/source-ingress.test.ts` checks that the ingress opens no lender for a tampered, forged, unsigned or live-mode delivery or while it is off, and reads its settings from the environment; `artifacts/api-server/tests/api-security.test.ts` sends a forged delivery through the whole application with no database and gets 401. No test calls Paystack or needs a key.

Documentation checked against the official pages on 18 September 2026. Provider behaviour observed with real test credentials must be recorded separately from these offline checks.
