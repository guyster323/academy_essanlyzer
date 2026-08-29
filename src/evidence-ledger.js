import { MAX_EVIDENCE_ROWS } from './series-engine.js';

function row(id, { caseId, t, source, signal, observation, derived, supports, contradicts, confidence, figureId, notes }) {
  return {
    Evidence_ID: id,
    Case: caseId || '',
    Timestamp_or_Age: t || '',
    Source_File: source || '',
    Signal: signal || '',
    Observation: observation || '',
    Derived_Metric: derived || '',
    Supports: supports || '',
    Contradicts: contradicts || '',
    Confidence: confidence || 'Medium',
    Figure_ID: figureId || '',
    Notes: notes || ''
  };
}

export function buildEvidenceLedger({ blocks = [], figures = [], anomalyWindows = [], commonMode = null } = {}) {
  const rows = [];
  let n = 1;
  const nextId = () => `E${String(n++).padStart(3, '0')}`;

  (blocks || []).forEach(block => {
    const derived = block.derived;
    if (derived?.alarmCount) {
      rows.push(row(nextId(), {
        source: block.label,
        signal: derived.label || 'derived',
        observation: `파생 이상 ${derived.alarmCount}건`,
        derived: JSON.stringify(Object.fromEntries(Object.entries(derived.metricStats || {}).slice(0, 4).map(([k, v]) => [k, v.max]))).slice(0, 300),
        supports: '독립 파생 탐지',
        confidence: 'High',
        notes: 'Observed 원문이 아니라 Derived'
      }));
    }
  });

  (anomalyWindows || []).slice(0, 20).forEach(w => {
    rows.push(row(nextId(), {
      t: w.timestamp,
      source: w.sourceFile,
      signal: w.parameter,
      observation: w.observedValue,
      derived: w.deviation,
      supports: w.alarmCode || '',
      confidence: w.evidenceTier === 'Observed' ? 'Confirmed' : 'High',
      notes: w.evidenceTier || ''
    }));
  });

  (figures || []).filter(f => f.available).forEach(f => {
    rows.push(row(nextId(), {
      signal: f.id,
      observation: f.claim,
      derived: JSON.stringify(f.summaryStats || {}).slice(0, 400),
      supports: f.claim,
      confidence: 'High',
      figureId: f.id,
      notes: f.evidenceTier
    }));
  });

  if (commonMode && commonMode.mode) {
    rows.push(row(nextId(), {
      signal: 'cross-asset',
      observation: commonMode.reason,
      derived: `mode=${commonMode.mode}; score=${commonMode.score}`,
      supports: commonMode.mode === 'common-mode' ? 'Common-mode / Grid / Dispatch' : 'Local hardware branch',
      contradicts: commonMode.mode === 'common-mode' ? 'Local PCS/BMS 단독 고장' : '전 계통 공통 요인',
      confidence: commonMode.mode === 'unknown' ? 'Unknown' : 'Medium',
      figureId: 'A-F4'
    }));
  }

  return rows.slice(0, MAX_EVIDENCE_ROWS);
}

export function catalogEvidence(ledger) {
  return (ledger || []).map(r => ({
    id: r.Evidence_ID,
    figureId: r.Figure_ID,
    observation: r.Observation,
    supports: r.Supports,
    contradicts: r.Contradicts,
    confidence: r.Confidence
  }));
}
