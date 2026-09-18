import express, { Router, type Request } from 'express';
import { clerkMiddleware, getAuth } from '@clerk/express';
import { authorizePilotAccess, PilotAccessError, type PilotAccessPolicy, type ProvisionedMembership, type VerifiedClerkSession } from '../lib/pilot-access';
import type { PilotStagingStore } from '../lib/pilot-staging-store';

export interface StagingProvisioning { membership: ProvisionedMembership; workspaceId: string; principalHash: string }
export interface PilotStagingDependencies {
  policy: PilotAccessPolicy;
  store: PilotStagingStore;
  /** Fresh server-owned provisioning. Never constructed from request body or browser-selected role. */
  loadProvisioning(userId: string, organizationId: string, tenantId: string): Promise<StagingProvisioning | null>;
}

/** Testable router; only the dedicated Clerk-authenticated staging app mounts it. */
export function createPilotStagingRouter(dependencies: PilotStagingDependencies, readVerifiedSession: (request: Request) => VerifiedClerkSession | null = request => getAuth(request, { acceptsToken: 'session_token' }) as VerifiedClerkSession) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); next(); });
  router.all('/lenders/:tenantId/records/:recordId', async (req, res) => {
    try {
      if (!['GET', 'PATCH'].includes(req.method)) { res.status(405).json({ error: 'This staging action is not supported.' }); return; }
      const origin = req.get('Origin');
      if (req.method !== 'GET' && (!origin || !dependencies.policy.authorisedParties.includes(origin))) { res.status(403).json({ error: 'Use the configured staging origin.' }); return; }
      const auth = readVerifiedSession(req);
      const tenantId = String(req.params.tenantId);
      const provisioned = auth?.userId && auth?.orgId ? await dependencies.loadProvisioning(auth.userId, auth.orgId, tenantId) : null;
      const grant = authorizePilotAccess(auth, provisioned?.membership, { tenantId, action: req.method === 'GET' ? 'read' : 'record_operations' }, dependencies.policy);
      const scope = { tenantId: grant.tenantId, workspaceId: provisioned!.workspaceId, principalHash: provisioned!.principalHash, actor: grant.userId };
      const id = String(req.params.recordId);
      if (req.method === 'GET') { res.json(await dependencies.store.read(scope, id)); return; }
      const body = req.body;
      if (!body || body.syntheticOnly !== true || Object.keys(body).some(key => !['syntheticOnly', 'note', 'expectedUpdatedAt'].includes(key)) || typeof body.note !== 'string' || typeof body.expectedUpdatedAt !== 'string') { res.status(400).json({ error: 'Provide a synthetic note and the version being edited.' }); return; }
      res.json(await dependencies.store.write(scope, { recordId: id, note: body.note, expectedUpdatedAt: body.expectedUpdatedAt, requestKey: req.get('Idempotency-Key') || '' }));
    } catch (error) {
      const status = error instanceof PilotAccessError ? error.status : Number((error as any)?.status) || 500;
      res.status(status >= 400 && status < 600 ? status : 500).json({ error: status === 409 ? 'The record or request changed. Reload before trying a new edit.' : status === 404 ? 'This customer is not available.' : status < 500 ? 'The staging request was refused. Check your membership, authentication factors and input.' : 'The staging request could not be completed.' });
    }
  });
  return router;
}

/** Explicitly constructed, separate host only. Not imported by app.ts or started by the sandbox. */
export function createPilotStagingApp(dependencies: PilotStagingDependencies, clerk: { publishableKey: string; secretKey: string; jwtKey?: string }) {
  if (!dependencies.policy.enabled || dependencies.policy.environment !== 'staging' || !clerk.publishableKey || !clerk.secretKey) throw new Error('Dedicated staging identity configuration is required.');
  const app = express();
  app.disable('x-powered-by');
  app.use(clerkMiddleware({ ...clerk, authorizedParties: [...dependencies.policy.authorisedParties] }));
  app.use(express.json({ limit: '8kb' }));
  app.use('/staging', createPilotStagingRouter(dependencies));
  return app;
}
