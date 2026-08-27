import { z } from 'zod';
import { EVIDENCE_TIERS, HYPOTHESIS_DOMAINS } from './schemas.js';

// Shared with the frontend's prompt-budget constants (src/pipeline.js) —
// keep these two in sync when either changes.
export const MAX_LOG_TEXT_CHARS = 300_000;
export const MAX_ANOMALY_WINDOWS = 200;
// Kept in sync with src/reference-docs.js's MAX_TOTAL_REFERENCE_CHARS.
export const MAX_REFERENCE_DOCS_CHARS = 60_000;

const LEVEL_ENUM = z.enum(['고', '중', '저']); // anomaly/issue severity-of-signal scale
const SEVERITY_ENUM = z.enum(['상', '중', '하']); // final incident severity scale
const EVIDENCE_TIER_ENUM = z.enum(EVIDENCE_TIERS);
const DOMAIN_ENUM = z.enum(HYPOTHESIS_DOMAINS);
const FORMAT_ID_ENUM = z.enum(['aemo-mms', 'lfp-cell-array', 'generic']);

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
  // A source with no single incident time (e.g. a derived-detection sweep
  // over a whole file) legitimately describes an observed date range plus a
  // caveat about sample-window coverage — observed live to exceed 200 chars.
  occurredAt: z.string().max(500),
  priorHistory: z.string().max(2000)
}).strict();

const sourceProfileSchema = z.object({
  sourceFile: z.string().min(1).max(500),
  formatId: FORMAT_ID_ENUM,
  formatLabel: z.string().max(200),
  entityColumn: z.string().max(200).nullable(),
  rowCount: z.number().int().nonnegative(),
  derivedAlarmCount: z.number().int().nonnegative()
}).strict();

const sourceProfilesSchema = z.array(sourceProfileSchema).max(10);

const anomalyWindowSchema = z.object({
  timestamp: z.string().max(200),
  sourceFile: z.string().max(500),
  parameter: z.string().max(200),
  // Format-aware derived detection (rolling z-score/MAD, cross-cell Vdev)
  // legitimately cites several alarm instances with per-instance metrics —
  // observed live to run well past a single-value 200-char budget. deviation
  // gets the same room since it likewise cross-references raw source values.
  observedValue: z.string().max(800),
  normalRange: z.string().max(200),
  deviation: z.string().max(800),
  alarmCode: z.string().max(200),
  level: LEVEL_ENUM,
  evidenceTier: EVIDENCE_TIER_ENUM
}).strict();

const confirmedHypRequestSchema = z.object({
  name: z.string().min(1).max(500),
  domain: DOMAIN_ENUM,
  expectedSignature: z.string().max(2000),
  actualObservation: z.string().max(2000),
  evidence: z.string().max(2000),
  evidenceTier: EVIDENCE_TIER_ENUM,
  disconfirmingEvidence: z.string().min(1).max(2000),
  missingSignals: z.string().min(1).max(2000),
  claimLimit: z.string().min(1).max(1200)
}).strict();

const logBlockFields = {
  combinedLogText: z.string().max(MAX_LOG_TEXT_CHARS),
  totalRows: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative()
};

/* ---- Request body schemas (one per endpoint) ---- */
const REQUEST_SCHEMAS = {
  'detect-issues': z.object({ ...logBlockFields, sourceProfiles: sourceProfilesSchema.optional() }).strict(),

  'detect-anomaly': z.object({
    csText: z.string().min(1).max(5000),
    priorCase: z.string().max(5000),
    ...logBlockFields,
    sourceProfiles: sourceProfilesSchema.optional()
  }).strict(),

  'generate-hypotheses': z.object({
    issueStructured: issueStructuredSchema,
    anomalyWindows: z.array(anomalyWindowSchema).max(MAX_ANOMALY_WINDOWS),
    priorCase: z.string().max(5000),
    referenceDocsText: z.string().max(MAX_REFERENCE_DOCS_CHARS).optional(),
    sourceProfiles: sourceProfilesSchema.optional()
  }).strict(),

  'draft-report': z.object({
    issueStructured: issueStructuredSchema,
    anomalyWindows: z.array(anomalyWindowSchema).max(MAX_ANOMALY_WINDOWS),
    confirmedHyp: confirmedHypRequestSchema,
    finalSeverity: SEVERITY_ENUM,
    finalSeverityReason: z.string().min(1).max(2000),
    sourceProfiles: sourceProfilesSchema.optional()
  }).strict()
};

/* ---- Structured-output (tool_use.input) schemas — defense in depth on top
   of strict:true, so a malformed response fails as a clean 502 instead of
   an opaque frontend crash. ---- */
const hypothesisSchema = z.object({
  id: z.string(), name: substantiveText(500), domain: DOMAIN_ENUM,
  expectedSignature: substantiveText(2000), actualObservation: substantiveText(2000), evidence: substantiveText(2000),
  evidenceTier: EVIDENCE_TIER_ENUM,
  disconfirmingEvidence: substantiveText(2000), missingSignals: substantiveText(2000),
  claimLimit: substantiveText(1200),
  confidence: z.enum(['High', 'Medium', 'Low']), severityDraft: SEVERITY_ENUM, severityReason: substantiveText(1000)
}).strict().refine(
  (h) => new Set([h.name, h.expectedSignature, h.actualObservation, h.evidence]).size === 4,
  { message: '가설의 name/expectedSignature/actualObservation/evidence 필드 내용이 서로 동일합니다 — 실제 분석 없이 동일 텍스트로 채워진 것으로 의심됩니다.' }
).refine(
  (h) => h.evidenceTier === 'Inferred',
  { message: '원인 가설의 evidenceTier는 Inferred여야 합니다 — Observed/Derived 사실과 인과 추론을 구분하십시오.' }
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

function hasCellArraySource(context) {
  return (context?.sourceProfiles || []).some(profile => profile.formatId === 'lfp-cell-array');
}

function hasDefinitivePhysicalCauseClaim(hypothesis) {
  const text = [hypothesis.name, hypothesis.expectedSignature, hypothesis.actualObservation, hypothesis.evidence]
    .join(' ');
  return /(?:전기화학적\s*열화|electrochemical\s*degradation)\s*(?:가|은|이)?\s*(?:확정(?:된)?\s*(?:원인)?|원인(?:이다|으로\s*판단))/i.test(text) ||
    /(?:커넥터|connector|부식|corrosion)[^.!?\n]{0,20}(?:가|은|이)?\s*(?:확정(?:된)?\s*(?:원인)?|원인(?:이다|으로\s*판단))/i.test(text);
}

function hasBoundedCellClaim(claimLimit) {
  return /(?:유효\s*직렬\s*저항|effective\s+series\s+resistance)/i.test(claimLimit) &&
    /(?:확정할\s*수\s*없|입증.*불가|판단.*불가|미확정|cannot|not\s+establish)/i.test(claimLimit);
}

function validateContextualHypotheses(result, context) {
  if (!hasCellArraySource(context)) return;
  const invalid = result.hypotheses.find(h => hasDefinitivePhysicalCauseClaim(h) || !hasBoundedCellClaim(h.claimLimit));
  if (!invalid) return;
  const error = new Error(
    '모델 응답 검증 실패: cell-array 로그에서는 전기화학적 열화·커넥터·부식 같은 물리적 원인을 확정할 수 없고, Cell N 경로의 유효 직렬저항 증가 수준으로 주장을 제한해야 합니다.'
  );
  error.status = 502;
  throw error;
}

export function parseStructuredResult(kind, input, context = {}) {
  // A schema failure here means Claude's response, not the caller's request.
  const schema = RESPONSE_SCHEMAS[kind];
  if (!schema) throw new Error(`Unknown validation kind: ${kind}`);
  const result = schema.safeParse(input);
  if (!result.success) {
    const err = new Error(`모델 응답 검증 실패: ${result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    err.status = 502;
    throw err;
  }
  if (kind === 'generate-hypotheses') validateContextualHypotheses(result.data, context);
  return result.data;
}
