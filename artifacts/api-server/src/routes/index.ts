import { Router, type IRouter } from "express";
import healthRouter from "./health";
import valopayRouter from "./valopay";
import connectedRouter from './connected';

const router: IRouter = Router();

router.use(healthRouter);
router.use(valopayRouter);
router.use(connectedRouter);

export default router;
