import { z } from 'zod';
import { inMerchantAsSystem, loadState, saveState, appendAudit, systemWorkspaceMatches, fail } from './valopay-store';
import type { PaystackConnectionTransaction } from '../routes/sources';

const connectionSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({ workspaceId:z.string().min(1).max(100), merchantId:z.string().min(1).max(100) }).strict());
/** Operators map an opaque endpoint to an existing synthetic lender. Browser
 * state, customer IDs and webhook fields can never choose the receiving tenant. */
export const paystackConnectionTransaction: PaystackConnectionTransaction = async (connectionId, apply) => {
  if(process.env.VALOPAY_PAYSTACK_INGRESS !== 'test')fail('Paystack test ingress is not configured.',503);
  const key=process.env.PAYSTACK_TEST_SECRET_KEY || '';
  if(!/^sk_test_[A-Za-z0-9_]{16,128}$/.test(key))fail('A Paystack test credential is required.',503);
  let mapping: z.infer<typeof connectionSchema>;
  try {mapping=connectionSchema.parse(JSON.parse(process.env.VALOPAY_PAYSTACK_CONNECTIONS || '{}'));}catch {fail('Paystack test connection configuration is invalid.',503);}
  const connection=mapping[connectionId];
  if(!connection)fail('Paystack test connection not found.',404);
  const result=await inMerchantAsSystem(connection.merchantId,'System · Paystack test evidence',async context=>{
    if(!systemWorkspaceMatches(context,connection.workspaceId))fail('Paystack test connection is unavailable.',403);
    const state=await loadState(context,connection.merchantId,'update');
    if(!['sandbox','observation'].includes(state.merchant.mode) || !state.merchant.killSwitch)fail('This test connection requires a disabled synthetic lender.',403);
    const receipt=await apply({state,context,secretKey:key});
    appendAudit(state,context,'paystack.test_event','provider-inbox','Authenticated test evidence received. No financial instruction was created.');
    await saveState(context,state);return receipt;
  });
  if(result===undefined)fail('The test lender is busy. Retry this delivery.',503);
  return result;
};
