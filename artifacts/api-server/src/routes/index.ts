import { Router, type IRouter } from "express";
import healthRouter from "./health";
import valopayRouter from "./valopay";

const router: IRouter = Router();

router.use(healthRouter);
router.use(valopayRouter);

export default router;
