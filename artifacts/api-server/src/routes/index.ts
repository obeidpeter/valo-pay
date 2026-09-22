import { Router, type IRouter } from "express";
import healthRouter from "./health";
import valopayRouter from "./valopay";
import connectedRouter from './connected';
import { recoveryMiddleware } from '../lib/operation-recovery';
import pilotRouter from './pilot';

const router: IRouter = Router();

router.use(healthRouter);
router.use(recoveryMiddleware);
router.use(valopayRouter);
router.use(connectedRouter);
router.use(pilotRouter);

export default router;
