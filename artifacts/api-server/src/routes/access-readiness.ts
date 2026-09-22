import { Router } from 'express';
import { inWorkspace, verifyWorkspaceEncryption, protectWorkspacePayloads } from '../lib/valopay-store';
import { payloadEncryptionKey } from '../lib/protected-payloads';
import { staffMode, staffPolicy } from '../lib/staff-access';
const router=Router();
router.get('/v1/team/readiness',async(req,res)=>res.json(await inWorkspace(req,res,async ctx=>{
  const staff=staffMode(),policy=staffPolicy();let encryptionConfigured=false;
  try{encryptionConfigured=!!payloadEncryptionKey();}catch{/* report incomplete configuration without secrets */}
  return {syntheticOnly:true,canCommission:ctx.role==='Admin',checkedAt:ctx.now,checks:[
    {id:'identity',name:'Staff identity',state:staff?'verified_this_request':'not_configured',detail:staff?'This request passed the configured issuer, organisation and active-membership checks.':'Configure a separate Clerk staging organisation and provision its first administrator.'},
    {id:'mfa',name:'Multi-factor authentication',state:ctx.accessMode==='staff'?'verified_this_request':'not_configured',detail:ctx.accessMode==='staff'?'The server verified MFA freshness. Sensitive changes require a factor used within ten minutes.':'Demo role changes do not verify a staff member or a second factor.'},
    {id:'origin',name:'Allowed staff origins',state:staff&&policy.authorisedParties.length?'configured':'not_configured',detail:'Staff changes must originate from the explicitly configured staging address.'},
    {id:'database',name:'Restricted database access',state:process.env.VALOPAY_RUNTIME_ISOLATION==='staging'?'verified_this_request':'not_configured',detail:process.env.VALOPAY_RUNTIME_ISOLATION==='staging'?'This request passed the restricted-role and forced row-security checks.':'Configure the isolated staging schema and a restricted runtime database role before commissioning.'},
    {id:'encryption',name:'Managed payload encryption',state:encryptionConfigured?'configured_not_verified':'not_configured',detail:encryptionConfigured?'A wrapping key is configured. Verify access, then protect existing imports and recovery payloads.':'Configure a managed wrapping key. No key or credential is stored in this screen.'},
  ]};
},'read')));
router.post('/v1/team/readiness/encryption',async(req,res)=>res.json(await inWorkspace(req,res,verifyWorkspaceEncryption,'team')));
router.post('/v1/team/readiness/protect',async(req,res)=>res.json(await inWorkspace(req,res,protectWorkspacePayloads,'team')));
export default router;
