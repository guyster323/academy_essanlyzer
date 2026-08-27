import { Router } from 'express';
import { callStructured } from '../lib/ai-provider.js';
import { detectIssuesTool, detectAnomalyTool, hypothesesTool, draftReportTool } from '../lib/schemas.js';
import { parseRequest, parseStructuredResult, ValidationError } from '../lib/validation.js';
import { retryOnce } from '../lib/retry.js';
import {
  PERSONA,
  buildDetectIssuesPrompt,
  buildDetectAnomalyPrompt,
  buildHypothesesPrompt,
  buildDraftReportPrompt
} from '../lib/prompts.js';

const router = Router();

async function callAndValidate(kind, handler, body) {
  const result = await handler(body);
  return parseStructuredResult(kind, result, body);
}

function wrap(kind, handler) {
  return async (req, res) => {
    try {
      const body = parseRequest(kind, req.body || {});
      // A 502 means either the model's response didn't match the schema
      // (observed live: a hypothesis with every field literally "test") or
      // the CLI/API call itself hiccuped — both are worth one automatic
      // retry before surfacing an error. 400/401/429/504 are not retried:
      // retrying won't fix a bad request, missing auth, a rate limit, or a
      // call that already waited out the full timeout.
      const validated = await retryOnce(
        () => callAndValidate(kind, handler, body),
        (e) => e.status === 502,
        (e) => console.warn(`[${kind}] retrying once after a 502 (${e.message})`)
      );
      res.json(validated);
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      if (!(e instanceof ValidationError) && status >= 500) console.error(e);
      // Never leak upstream stack traces / API key details past the message string.
      res.status(status).json({ error: e.message || String(e) });
    }
  };
}

router.post('/detect-issues', wrap('detect-issues', async (body) => {
  const prompt = buildDetectIssuesPrompt(body);
  return callStructured({ system: PERSONA, prompt, tool: detectIssuesTool, maxTokens: 1500 });
}));

router.post('/detect-anomaly', wrap('detect-anomaly', async (body) => {
  const prompt = buildDetectAnomalyPrompt(body);
  return callStructured({ system: PERSONA, prompt, tool: detectAnomalyTool, maxTokens: 2000 });
}));

router.post('/generate-hypotheses', wrap('generate-hypotheses', async (body) => {
  const prompt = buildHypothesesPrompt(body);
  return callStructured({ system: PERSONA, prompt, tool: hypothesesTool, maxTokens: 2000 });
}));

router.post('/draft-report', wrap('draft-report', async (body) => {
  const prompt = buildDraftReportPrompt(body);
  return callStructured({ system: PERSONA, prompt, tool: draftReportTool, maxTokens: 2000 });
}));

export default router;
