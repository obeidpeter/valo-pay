import { Router, type IRouter } from "express";
import healthRouter from "./health";
import valopayRouter from "./valopay";
import connectedRouter from './connected';
import { recoveryMiddleware } from '../lib/operation-recovery';
import pilotRouter from './pilot';
import closeReviewRouter from './close-review';
import sourcesRouter from './sources';
import workRouter from './work';
import staffLenderRouter from './staff-lender-access';
import accessReadinessRouter from './access-readiness';
import lifecycleRouter from './lifecycle';

const router: IRouter = Router();

router.use(healthRouter);
router.use(recoveryMiddleware);
router.use(valopayRouter);
router.use(connectedRouter);
router.use(pilotRouter);
router.use(closeReviewRouter);
router.use(sourcesRouter);
router.use(workRouter);
router.use(staffLenderRouter);
router.use(accessReadinessRouter);
router.use(lifecycleRouter);

export default router;
