import { Router } from 'express';
import { inWorkspace, verifyWorkspaceEncryption, protectWorkspacePayloads, runtimeIsolationVerified, type StoreContext } from '../lib/valopay-store';
import { payloadEncryptionKey } from '../lib/protected-payloads';
import { staffMode, staffPolicy } from '../lib/staff-access';
const router=Router();
/** The readiness checks for one workspace transaction. The database check is this transaction's own:
 * a set that differs from the reviewed one refuses the request before this runs, and a transaction that
 * recorded no check reports none, whatever the configuration says. */
export async function readinessChecks(ctx:StoreContext){
  const staff=staffMode(),policy=staffPolicy(),isolated=runtimeIsolationVerified(ctx);let encryptionConfigured=false;
  try{encryptionConfigured=!!payloadEncryptionKey();}catch{/* report incomplete configuration without secrets */}
  return {syntheticOnly:true,canCommission:ctx.role==='Admin',checkedAt:ctx.now,checks:[
    {id:'identity',name:'Staff identity',state:staff?'verified_this_request':'not_configured',detail:staff?'This request passed the configured issuer, organisation and active-membership checks.':'Configure a separate Clerk staging organisation and provision its first administrator.'},
    {id:'mfa',name:'Multi-factor authentication',state:ctx.accessMode==='staff'?'verified_this_request':'not_configured',detail:ctx.accessMode==='staff'?'The server verified MFA freshness. Sensitive changes require a factor used within ten minutes.':'Demo role changes do not verify a staff member or a second factor.'},
    {id:'origin',name:'Allowed staff origins',state:staff&&policy.authorisedParties.length?'configured':'not_configured',detail:'Staff changes must originate from the explicitly configured staging address.'},
    {id:'database',name:'Restricted database access',state:isolated?'verified_this_request':'not_configured',detail:isolated?'This request passed the restricted-role, forced row-security and reviewed-policy checks: every row-security policy, scope helper and the workspace guard match migrations 005 and 006.':'Configure the isolated staging schema and a restricted runtime database role before commissioning.'},
    {id:'encryption',name:'Managed payload encryption',state:encryptionConfigured?'configured_not_verified':'not_configured',detail:encryptionConfigured?'A wrapping key is configured. Verify access, then protect existing imports and recovery payloads.':'Configure a managed wrapping key. No key or credential is stored in this screen.'},
  ]};
}
router.get('/v1/team/readiness',async(req,res)=>res.json(await inWorkspace(req,res,readinessChecks,'read')));
router.post('/v1/team/readiness/encryption',async(req,res)=>res.json(await inWorkspace(req,res,verifyWorkspaceEncryption,'team')));
router.post('/v1/team/readiness/protect',async(req,res)=>res.json(await inWorkspace(req,res,protectWorkspacePayloads,'team')));
export default router;
