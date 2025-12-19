// File: /src/routes/gptRoutes.js

import express from 'express';
import { generateBizzyResponse } from '../gpt/generateBizzyResponse.js';

const router = express.Router();

router.post('/generate-response', generateBizzyResponse);

export default router;
