/**
 * Analysis-window helpers. Anchor selection follows the range the app
 * already knows (CS text, selected issue, structured issue, anomaly
 * windows) instead of always searching the whole loaded series.
 * Dates and times are parsed generically — no incident-specific clock.
 */

import { parseTimestampMs } from './series-engine.js';

function offsetMinutesOf(assumption) {
  return assumption && Number.isFinite(assumption.offsetMinutes) ? assumption.offsetMinutes : 0;
}

export function civilDayRange(year, month, day, offsetMinutes = 0) {
  const startMs = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60000;
  return { minMs: startMs, maxMs: startMs + 24 * 3600 * 1000 };
}

export function civilDayContaining(ms, offsetMinutes = 0) {
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + offsetMinutes * 60000);
  return civilDayRange(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    offsetMinutes
  );
}

export function civilDateLabel(ms, offsetMinutes = 0) {
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + offsetMinutes * 60000);
  return shifted.toISOString().slice(0, 10);
}

export function seriesSpanLabel(frozen, offsetMinutes = 0) {
  const t0 = frozen?.bins?.[0]?.t;
  const t1 = frozen?.bins?.[frozen.bins.length - 1]?.t;
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return '관측 구간';
  const a = civilDateLabel(t0, offsetMinutes);
  const b = civilDateLabel(t1, offsetMinutes);
  if (!a || !b) return '관측 구간';
  return a === b ? a : `${a} ~ ${b}`;
}

function mergeRanges(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    minMs: Math.min(a.minMs, b.minMs),
    maxMs: Math.max(a.maxMs, b.maxMs)
  };
}

function rangeFromParsed(ms, hadTime, offsetMinutes) {
  if (!Number.isFinite(ms)) return null;
  if (!hadTime) {
    const shifted = new Date(ms + offsetMinutes * 60000);
    return civilDayRange(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate(),
      offsetMinutes
    );
  }
  return civilDayContaining(ms, offsetMinutes);
}

const ISO_OR_SLASH = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/g;
const KR_DATE = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:[^\d]{0,6}(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?)?/g;

function collectFromText(text, assumption, source) {
  const out = [];
  if (!text) return out;
  const offset = offsetMinutesOf(assumption);
  const s = String(text);
  let m;
  ISO_OR_SLASH.lastIndex = 0;
  while ((m = ISO_OR_SLASH.exec(s))) {
    const wall = m[4] != null
      ? `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${pad(m[5])}:${pad(m[6] || '0')}`
      : `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    const ms = parseTimestampMs(wall, assumption);
    const range = rangeFromParsed(ms, m[4] != null, offset);
    if (range) out.push({ range, source, raw: m[0] });
  }
  KR_DATE.lastIndex = 0;
  while ((m = KR_DATE.exec(s))) {
    const hadTime = m[4] != null;
    const wall = hadTime
      ? `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${pad(m[5] || '0')}:00`
      : `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    const ms = parseTimestampMs(wall, assumption);
    const range = rangeFromParsed(ms, hadTime, offset);
    if (range) out.push({ range, source, raw: m[0] });
  }
  return out;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function collectFromStamp(raw, assumption, source) {
  if (raw == null || raw === '') return [];
  return collectFromText(String(raw), assumption, source);
}

/**
 * Union of civil days implied by CS / selected issue / structured issue /
 * anomaly windows. null when none of those carry a parseable date.
 */
export function resolveAnalysisScope({
  csText, selectedIssue, issueStructured, anomalyWindows, assumption
} = {}) {
  const hits = [
    ...collectFromStamp(selectedIssue?.occurredAt, assumption, 'selected-issue'),
    ...collectFromText(selectedIssue?.description, assumption, 'selected-issue'),
    ...collectFromStamp(issueStructured?.occurredAt, assumption, 'issue-structured'),
    ...collectFromText(csText, assumption, 'cs-text')
  ];
  for (const win of anomalyWindows || []) {
    hits.push(...collectFromStamp(win.timestamp, assumption, 'anomaly-window'));
  }
  if (!hits.length) return null;

  let range = null;
  const sources = new Set();
  for (const hit of hits) {
    range = mergeRanges(range, hit.range);
    sources.add(hit.source);
  }
  const offset = offsetMinutesOf(assumption);
  const label = `${civilDateLabel(range.minMs, offset)} ~ ${civilDateLabel(range.maxMs - 1, offset)}`;
  const sameDay = civilDateLabel(range.minMs, offset) === civilDateLabel(range.maxMs - 1, offset);
  return {
    minMs: range.minMs,
    maxMs: range.maxMs,
    label: sameDay ? civilDateLabel(range.minMs, offset) : label,
    sources: [...sources]
  };
}
