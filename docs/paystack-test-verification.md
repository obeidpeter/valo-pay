# Independently verify a saved Paystack test event

This is an explicit operator workflow for synthetic workspaces. It is not a live payment integration, an instruction route or an automatic background poller. The application still refuses live credentials and live connected operations. No provider account or credential was available during implementation; all automated verification uses injected offline HTTP responses.

## Prerequisites

Use the existing operator-provisioned `VALOPAY_PAYSTACK_INGRESS=test` configuration, a valid `PAYSTACK_TEST_SECRET_KEY` in secret storage, and the existing `VALOPAY_PAYSTACK_CONNECTIONS` mapping. The opaque connection ID must identify the intended workspace and lender. Never supply a credential on the command line.

The lender must have `settings.environment=sandbox`, mode `observation` or `sandbox`, and its emergency stop **on**. If restricted runtime isolation is enabled, the configured service identity must also retain the appropriate membership and lender grant; the ordinary repository checks still apply.

The inbox must contain an authenticated `test`-mode payment event in `awaiting_verification`. A local fixture, quarantine or mandate event cannot be promoted. There must be exactly one persisted collection attempt matching the reference, bound to an existing customer and that customer's instalment. Its amount and currency must match the event, its currency must explicitly be `NGN`, and its `data.providerConnection` must equal `paystack:test:<opaque connection ID>`. The verified channel must be `direct_debit`. Create/review that expectation through the existing controlled import or record workflow before verifying; the command does not create its own expectation or accept an amount/customer from CLI input.

## Run after access is available

```sh
pnpm --filter @workspace/scripts exec tsx ./src/verify-paystack-event.ts --connection-id <opaque-test-connection> --event-id <saved-test-event>
```

`--help` reads no provider or database. A configured run makes a fixed-origin `GET https://api.paystack.co/transaction/verify/<saved-reference>` only. Redirects are refused and the existing bounded response/timeout controls apply. There is no initialise, transfer, debit or retry-payment endpoint in this adapter.

The command first snapshots the signed event and collection expectation under the mapped lender transaction. It releases the transaction before HTTP. A second transaction checks the current mapping, credential, workspace mode, emergency stop, event identity and exact saved attempt contents again. A changed expectation or authority prevents application of the result. Concurrent attempts converge on the existing verified receipt; an incomplete restore that lost its observation is held for operator recovery review.

A matching successful response appends one normalised observation and an immutable verification entry to the event's existing append-only check history. Original signed evidence is unchanged. It creates **no Payment or allocation**. Run ordinary reconciliation to consume the observation: it may create/link the canonical payment and allocate it under the existing rules. The payment remains **unsettled** until separate settlement evidence exists. Reconciliation of the same observation does not create a second payment.

An unavailable, timed-out, rate-limited or not-found response retains an unknown outcome. A conflicting identity, amount, currency, channel, failure or reversal requires review. Neither situation authorises a replacement debit. Ordinary replay cannot regress a verified event. At most 100 recorded checks are allowed per event before operator investigation.

## Verification evidence and limits

`artifacts/api-server/tests/paystack-verification.test.ts` runs the actual adapter with injected HTTP, the actual domain workflow, repository final-state guards and normal reconciliation. It checks fixed-origin GET-only behaviour, no network while a lender transaction is held, fixture refusal, subject/route/money binding, fresh authority after HTTP, no-regression/deduplication, commit rollback, lost response and missing-observation restore holds. `scripts/paystack-verification-command.test.mjs` executes the CLI entrypoint and checks help and refusal before network when credentials, mappings or database configuration are absent.

These tests do not establish provider connectivity, direct-debit product access, merchant ownership, bank route coverage, provider event delivery, production recovery or contractual authority. An actual account/test credential and independently reviewed provider acceptance evidence remain required. Real instruction routes, scheduled verification and live-data use stay disabled.
