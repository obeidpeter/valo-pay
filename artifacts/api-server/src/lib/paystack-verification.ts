import {
  appendAudit,
  inMerchantAsSystem,
  loadState,
  saveState,
  systemWorkspaceMatches,
  fail,
} from "./valopay-store";
import { createPaystackTestAdapter } from "../providers/paystack";
import {
  paystackConnections,
  paystackTestSecretKey,
} from "../providers/paystack-ingress-config";
import {
  verifyQueuedPaystackEvent,
  type PaystackVerificationTransaction,
} from "../providers/paystack-verification";

/** Operator-only test evidence preparation. No HTTP route or background scheduler
 * calls this function. Configure a disabled synthetic lender before running it. */
export async function verifyStoredPaystackTestEvent(
  connectionId: string,
  eventId: string,
) {
  const secretKey = paystackTestSecretKey();
  const mapping = paystackConnections();
  const connection = Object.hasOwn(mapping, connectionId)
    ? mapping[connectionId]
    : undefined;
  if (!connection) fail("Paystack test connection not found.", 404);
  const transact: PaystackVerificationTransaction = async (
    id,
    write,
    apply,
  ) => {
    const currentConfiguration = () => {
      const current = paystackConnections()[id];
      if (
        id !== connectionId ||
        paystackTestSecretKey() !== secretKey ||
        !current ||
        current.workspaceId !== connection.workspaceId ||
        current.merchantId !== connection.merchantId
      )
        fail(
          "The test connection changed during verification. No provider result was applied.",
          409,
        );
    };
    currentConfiguration();
    const result = await inMerchantAsSystem(
      connection.merchantId,
      "System · Paystack test verification",
      async (ctx) => {
        if (!systemWorkspaceMatches(ctx, connection.workspaceId))
          fail("Paystack test connection is unavailable.", 403);
        const state = await loadState(ctx, connection.merchantId, "update");
        currentConfiguration();
        const result = apply(state, ctx);
        if (write) {
          appendAudit(
            state,
            ctx,
            "paystack.test_verification",
            eventId,
            "An operator independently checked stored test evidence. No financial instruction was created.",
          );
          await saveState(ctx, state);
        }
        return result;
      },
    );
    if (result === undefined)
      fail(
        "The mapped test lender is unavailable or busy. Check the same event later.",
        503,
      );
    return result;
  };
  return verifyQueuedPaystackEvent({
    connectionId,
    eventId,
    transact,
    adapter: createPaystackTestAdapter({ secretKey }),
  });
}
