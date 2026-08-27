import { z } from 'zod';

// Shared with the frontend's prompt-budget constants (src/pipeline.js) —
// keep these two in sync when either changes.
export const MAX_LOG_TEXT_CHARS = 300_000;
export const MAX_ANOMALY_WINDOWS = 200;
// Kept in sync with src/reference-docs.js's MAX_TOTAL_REFERENCE_CHARS.
export const MAX_REFERENCE_DOCS_CHARS = 60_000;

const LEVEL_ENUM = z.enum(['고', '중', '저']); // anomaly/issue severity-of-signal scale
const SEVERITY_ENUM = z.enum(['상', '중', '하']); // final incident severity scale
const DOMAIN_ENUM = z.enum(['Battery/BMS', 'PCS', 'EMS', 'Contactor/CB', 'Cooling/HVAC', 'Communication/Sensor']);

// Guards against a degenerate model response that satisfies the JSON schema
// shape but not its substance — observed live via the CLI provider (every
// field of a hypothesis literally filled with the string "test"). Only
// applied to fields that should always carry real analysis prose; fields
// that can legitimately be short placeholders themselves (e.g. priorHistory
// "없음", alarmCode "0") are left as plain z.string().
const PLACEHOLDER_PATTERN = /^(test|todo|placeholder|n\/a|na|xxx|tbd|lorem ipsum|foo|bar|example|sample|없음|미상)$/i;
function substantiveText(maxLen) {
  return z.string().min(1).max(maxLen).refine(
    (v) => !PLACEHOLDER_PATTERN.test(v.trim()),
    { message: '플레이스홀더로 의심되는 내용입니다(예: "test")' }
  );
}

const issueStructuredSchema = z.object({
  issueType: z.string().max(500),
  facility: z.string().max(500),
  occurredAt: z.string().max(200),
  priorHistory: z.string().max(2000)
}).strict();

const anomalyWindowSchema = z.object({
  timestamp: z.string().max(200),
  sourceFile: z.string().max(500),
  parameter: z.string().max(200),
  observedValue: z.string().max(200),
  normalRange: z.string().max(200),
  deviation: z.string().max(200),
  alarmCode: z.string().max(200),
  level: LEVEL_ENUM
}).strict();

const confirmedHypRequestSchema = z.object({
  name: z.string().min(1).max(500),
  domain: DOMAIN_ENUM,
  expectedSignature: z.string().max(2000),
  actualObservation: z.string().max(2000),
  evidence: z.string().max(2000)
}).strict();

const logBlockFields = {
  combinedLogText: z.string().max(MAX_LOG_TEXT_CHARS),
  totalRows: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative()
};

/* ---- Request body schemas (one per endpoint) ---- */
const REQUEST_SCHEMAS = {
  'detect-issues': z.object(logBlockFields).strict(),

  'detect-anomaly': z.object({
    csText: z.string().min(1).max(5000),
    priorCase: z.string().max(5000),
    ...logBlockFields
  }).strict(),

  'generate-hypotheses': z.object({
    issueStructured: issueStructuredSchema,
    anomalyWindows: z.array(anomalyWindowSchema).max(MAX_ANOMALY_WINDOWS),
    priorCase: z.string().max(5000),
    referenceDocsText: z.string().max(MAX_REFERENCE_DOCS_CHARS).optional()
  }).strict(),

  'draft-report': z.object({
    issueStructured: issueStructuredSchema,
    anomalyWindows: z.array(anomalyWindowSchema).max(MAX_ANOMALY_WINDOWS),
    confirmedHyp: confirmedHypRequestSchema,
    finalSeverity: SEVERITY_ENUM,
    finalSeverityReason: z.string().min(1).max(2000)
  }).strict()
};

/* ---- Structured-output (tool_use.input) schemas — defense in depth on top
   of strict:true, so a malformed response fails as a clean 502 instead of
   an opaque frontend crash. ---- */
const hypothesisSchema = z.object({
  id: z.string(), name: substantiveText(500), domain: DOMAIN_ENUM,
  expectedSignature: substantiveText(2000), actualObservation: substantiveText(2000), evidence: substantiveText(2000),
  confidence: z.enum(['High', 'Medium', 'Low']), severityDraft: SEVERITY_ENUM, severityReason: substantiveText(1000)
}).strict().refine(
  (h) => new Set([h.name, h.expectedSignature, h.actualObservation, h.evidence]).size === 4,
  { message: '가설의 name/expectedSignature/actualObservation/evidence 필드 내용이 서로 동일합니다 — 실제 분석 없이 동일 텍스트로 채워진 것으로 의심됩니다.' }
);

const RESPONSE_SCHEMAS = {
  'detect-issues': z.object({
    issues: z.array(z.object({
      id: z.string(), title: substantiveText(500), occurredAt: z.string(), sourceFile: z.string(),
      description: substantiveText(3000), alarmCodes: z.array(z.string()), level: LEVEL_ENUM
    }).strict()).max(4)
  }).strict(),

  'detect-anomaly': z.object({
    issueStructured: issueStructuredSchema,
    anomalyWindows: z.array(anomalyWindowSchema)
  }).strict(),

  'generate-hypotheses': z.object({
    hypotheses: z.array(hypothesisSchema).min(1).max(3)
  }).strict(),

  'draft-report': z.object({
    report: z.object({
      headline: substantiveText(1000), occurrence: substantiveText(3000), anomalySummary: substantiveText(3000),
      rootCause: substantiveText(3000), actionRecommendation: substantiveText(3000)
    }).strict(),
    email: z.object({ to: z.string().min(1), subject: substantiveText(500), body: substantiveText(5000) }).strict()
  }).strict()
};

export class ValidationError extends Error {
  constructor(message, issues) {
    super(message);
    this.status = 400;
    this.issues = issues;
  }
}

function parseWith(schemas, kind, data, label) {
  const schema = schemas[kind];
  if (!schema) throw new Error(`Unknown validation kind: ${kind}`);
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(`${label} 검증 실패: ${result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`, result.error.issues);
  }
  return result.data;
}

export function parseRequest(kind, body) {
  return parseWith(REQUEST_SCHEMAS, kind, body, '요청');
}

export function parseStructuredResult(kind, input) {
  // A schema failure here means Claude's response, not the caller's request.
  const schema = RESPONSE_SCHEMAS[kind];
  if (!schema) throw new Error(`Unknown validation kind: ${kind}`);
  const result = schema.safeParse(input);
  if (!result.success) {
    const err = new Error(`모델 응답 검증 실패: ${result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    err.status = 502;
    throw err;
  }
  return result.data;
}
