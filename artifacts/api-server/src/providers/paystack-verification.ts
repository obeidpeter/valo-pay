import { createHash } from "node:crypto";
import { canonicalJson } from "@workspace/valopay-schema";
import { makeRecord, touch } from "../domain/records";
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import type { ExpectedPayment, RecoveryResult } from "./paystack";

export type PaystackVerificationTransaction = <T>(
  connectionId: string,
  write: boolean,
  apply: (state: DomainState, ctx: Context) => T,
) => Promise<T>;
export type PaystackVerificationAdapter = {
  recoverUnknown(expected: ExpectedPayment): Promise<RecoveryResult>;
};
function refuse(message: string, status = 409): never {
  throw Object.assign(new Error(message), { status });
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const paystackTestConnectionIdentity = (connectionId: string) =>
  `paystack:test:${connectionId}`;

function eligible(state: DomainState) {
  if (
    state.settings.environment !== "sandbox" ||
    !["sandbox", "observation"].includes(state.merchant.mode) ||
    !state.merchant.killSwitch
  )
    refuse(
      "Verification requires a synthetic workspace in observation mode with its emergency stop on.",
      403,
    );
}
function eventIn(state: DomainState, connectionId: string, eventId: string) {
  const event = state.records.find(
    (record) =>
      record.id === eventId &&
      record.kind === "provider-events" &&
      record.merchantId === state.merchant.id &&
      record.data.connectionId === connectionId,
  );
  if (!event)
    refuse("The provider event was not found in the mapped test lender.", 404);
  if (event.data.mode !== "test" || event.data.event?.kind !== "payment")
    refuse(
      "Only an authenticated test payment event can be independently verified. Local fixtures cannot be promoted.",
      403,
    );
  if (!["awaiting_verification", "verified"].includes(event.status))
    refuse(
      "This provider event is held for review and cannot be verified automatically.",
    );
  return event;
}
function expectation(
  state: DomainState,
  event: ValopayRecord,
  connectionId: string,
) {
  const payment = event.data.event.payment;
  const matches = state.records.filter(
    (record) =>
      record.kind === "attempts" &&
      record.merchantId === state.merchant.id &&
      [record.reference, record.data.providerReference].includes(
        payment.reference,
      ),
  );
  if (matches.length !== 1)
    refuse(
      "Exactly one saved collection expectation must match this test reference.",
    );
  const attempt = matches[0]!;
  const due = state.records.find(
    (record) =>
      record.kind === "due-items" &&
      record.id === attempt.data.dueItemId &&
      record.merchantId === state.merchant.id,
  );
  const customer = state.records.find(
    (record) =>
      record.kind === "customers" &&
      record.id === attempt.customerId &&
      record.merchantId === state.merchant.id,
  );
  if (
    !due ||
    !customer ||
    due.customerId !== attempt.customerId ||
    attempt.amountKobo !== payment.amountKobo ||
    payment.currency !== "NGN" ||
    payment.channel !== "direct_debit" ||
    attempt.data.currency !== "NGN" ||
    attempt.data.providerConnection !==
      paystackTestConnectionIdentity(connectionId)
  )
    refuse(
      "The saved customer, instalment, amount, currency and test-provider connection must match the signed evidence.",
    );
  return { attempt, due, customer };
}
const eventHash = (event: ValopayRecord) =>
  hash({
    id: event.id,
    merchantId: event.merchantId,
    reference: event.reference,
    amountKobo: event.amountKobo,
    event: event.data.event,
    payloadDigest: event.data.payloadDigest,
  });
const receiptOf = (state: DomainState, event: ValopayRecord) => {
  const verification = (
    event.data.replayHistory as Array<Record<string, unknown>> | undefined
  )?.find((entry) => entry.kind === "independent_transaction_verification");
  const observation = state.records.find(
    (record) =>
      record.kind === "observations" &&
      record.id === verification?.observationId &&
      record.merchantId === state.merchant.id &&
      record.data.providerEventId === event.id,
  );
  if (!verification || !observation)
    refuse(
      "The verified event is missing its retained observation. Hold it for recovery review; do not recreate it automatically.",
    );
  return {
    status: "verified" as const,
    observationCreated: false,
    financialRecordsCreated: 0 as const,
    instructions: "disabled" as const,
  };
};

/** Explicit operator test verification. The HTTP lookup occurs between two short
 * lender transactions. Its result is useful only if the expectation and authority
 * remain current. It never creates an instruction, Payment or allocation. */
export async function verifyQueuedPaystackEvent(input: {
  connectionId: string;
  eventId: string;
  transact: PaystackVerificationTransaction;
  adapter: PaystackVerificationAdapter;
}) {
  if (
    !/^[a-f0-9]{64}$/.test(input.connectionId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.eventId)
  )
    refuse(
      "Use the opaque configured test connection and a saved event ID.",
      400,
    );
  const prepared = await input.transact(
    input.connectionId,
    false,
    (state, ctx) => {
      eligible(state);
      const event = eventIn(state, input.connectionId, input.eventId);
      if (event.status === "verified")
        return { previous: receiptOf(state, event) };
      if ((event.data.replayHistory?.length ?? 0) >= 100)
        refuse(
          "This event reached its check limit. Ask the operator to review the retained evidence.",
        );
      const { attempt, due, customer } = expectation(
        state,
        event,
        input.connectionId,
      );
      return {
        pending: {
          eventHash: eventHash(event),
          attemptHash: hash(attempt),
          dueId: due.id,
          customerId: customer.id,
          merchantId: state.merchant.id,
          startedAt: ctx.now,
          expected: {
            reference: event.data.event.payment.reference,
            amountKobo: attempt.amountKobo,
            currency: "NGN" as const,
            channel: "direct_debit" as const,
          },
        },
      };
    },
  );
  if (prepared.previous) return prepared.previous;
  const pending = prepared.pending!;
  const outcome = await input.adapter.recoverUnknown(pending.expected);
  return input.transact(input.connectionId, true, (state, ctx) => {
    eligible(state);
    const event = eventIn(state, input.connectionId, input.eventId);
    if (event.status === "verified") return receiptOf(state, event);
    if ((event.data.replayHistory?.length ?? 0) >= 100)
      refuse("This event reached its check limit. Ask the operator to review the retained evidence.");
    const { attempt, due, customer } = expectation(
      state,
      event,
      input.connectionId,
    );
    if (
      state.merchant.id !== pending.merchantId ||
      eventHash(event) !== pending.eventHash ||
      hash(attempt) !== pending.attemptHash ||
      due.id !== pending.dueId ||
      customer.id !== pending.customerId
    )
      refuse(
        "The stored expectation or signed evidence changed during verification. Review it before checking the same reference again.",
      );
    let status = "awaiting_verification",
      message =
        "The test outcome remains unconfirmed. Check the same reference later; do not issue another payment.";
    let observationId: string | undefined;
    if (
      outcome.outcome === "unknown" &&
      outcome.nextAction === "manual_review"
    ) {
      status = "quarantined";
      message =
        "Independent verification could not validate this evidence. The recorded reason requires operator review; no observation was created.";
    }
    if (outcome.outcome === "verified") {
      const payment = outcome.payment,
        signed = event.data.event.payment;
      const matched =
        payment.provider === "paystack" &&
        payment.domain === "test" &&
        payment.transactionId === signed.transactionId &&
        payment.reference === pending.expected.reference &&
        payment.amountKobo === pending.expected.amountKobo &&
        payment.currency === "NGN" &&
        payment.channel === "direct_debit";
      if (!matched || ["failed", "reversed"].includes(payment.state)) {
        status = "quarantined";
        message =
          "Independent verification conflicts with the signed success event. Both results are retained for review; no observation was created.";
      } else if (payment.state === "succeeded") {
        const identity = `paystack:test:verified:${payment.transactionId}`;
        if (
          state.records.some(
            (record) =>
              record.kind === "observations" &&
              record.data.providerConnection ===
                paystackTestConnectionIdentity(input.connectionId) &&
              record.data.eventId === identity,
          )
        )
          refuse(
            "An observation already holds this transaction identity. Review the original evidence instead of creating another.",
          );
        const observation = makeRecord(state, "observations", {
          name: "Independently verified Paystack test receipt",
          status: "unresolved",
          reference: payment.reference,
          amountKobo: payment.amountKobo,
          customerId: customer.id,
          createdAt: ctx.now,
          data: {
            source: "webhook",
            eventId: identity,
            providerReference: payment.reference,
            providerConnection: paystackTestConnectionIdentity(
              input.connectionId,
            ),
            currency: "NGN",
            dueItemId: due.id,
            providerEventId: event.id,
            providerTransactionId: payment.transactionId,
            verification: {
              mode: "test",
              verifiedAt: ctx.now,
              startedAt: pending.startedAt,
              expectedAttemptHash: pending.attemptHash,
              eventHash: pending.eventHash,
            },
            synthetic: true,
          },
        });
        observationId = observation.id;
        status = "verified";
        message =
          "Independent test verification matched the saved expectation. One observation is ready for normal reconciliation; settlement is not confirmed and no financial instruction was created.";
      }
    }
    event.status = status;
    event.data.message = message;
    event.data.replayHistory = [
      ...event.data.replayHistory,
      {
        at: ctx.now,
        actor: ctx.actor,
        reason: "Explicit operator read-only test verification",
        result: status,
        kind: observationId
          ? "independent_transaction_verification"
          : "independent_transaction_check",
        ...(observationId ? { observationId } : {}),
        outcome,
      },
    ];
    touch(event, ctx.now);
    return {
      status,
      observationCreated: !!observationId,
      financialRecordsCreated: 0 as const,
      instructions: "disabled" as const,
    };
  });
}
