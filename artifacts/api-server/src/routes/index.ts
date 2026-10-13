import { Router, type IRouter } from "express";
import healthRouter from "./health";
import rewindRouter from "./rewind";

const router: IRouter = Router();
router.use(healthRouter);
router.use(rewindRouter);
export default router;
