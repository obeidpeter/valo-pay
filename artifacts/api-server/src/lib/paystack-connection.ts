import { inMerchantAsSystem, loadState, saveState, appendAudit, systemWorkspaceMatches, fail } from './valopay-store';
import { paystackConnections, paystackTestSecretKey } from '../providers/paystack-ingress-config';
import type { PaystackConnectionTransaction, PaystackIngress } from '../routes/sources';

/** Operators map an opaque endpoint to an existing synthetic lender. Browser
 * state, customer IDs and webhook fields can never choose the receiving tenant. */
export const paystackConnectionTransaction: PaystackConnectionTransaction = async (connectionId, apply) => {
  // The route has already checked the switch and key; direct callers are held to them too.
  paystackTestSecretKey();
  const mapping=paystackConnections();
  const connection=Object.hasOwn(mapping,connectionId)?mapping[connectionId]:undefined;
  if(!connection)fail('Paystack test connection not found.',404);
  const result=await inMerchantAsSystem(connection.merchantId,'System · Paystack test evidence',async context=>{
    if(!systemWorkspaceMatches(context,connection.workspaceId))fail('Paystack test connection is unavailable.',403);
    const state=await loadState(context,connection.merchantId,'update');
    if(!['sandbox','observation'].includes(state.merchant.mode) || !state.merchant.killSwitch)fail('This test connection requires a disabled synthetic lender.',403);
    const receipt=await apply({state,context});
    appendAudit(state,context,'paystack.test_event','provider-inbox','Authenticated test evidence received. No financial instruction was created.');
    await saveState(context,state);return receipt;
  });
  if(result===undefined)fail('The test lender is busy. Retry this delivery.',503);
  return result;
};

/** The ingress app.ts mounts: the key comes from the environment alone, so a delivery is verified before any lender is opened. */
export const paystackIngress: PaystackIngress = { secretKey: paystackTestSecretKey, transact: paystackConnectionTransaction };
