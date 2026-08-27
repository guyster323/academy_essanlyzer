/* =========================================================
   LOG FORMAT ADAPTERS
   The streaming engine (log-engine.js) is format-agnostic; each adapter
   tells it how to recognize comment/header/data rows, where the real
   columns start, which column (if any) identifies a groupable entity
   (e.g. a market participant / BESS unit), which column is the primary
   timestamp, and what counts as an "alarm" row.
========================================================= */

export function detectDelimiter(sampleLine) {
  const candidates = [',', '\t', ';', '|'];
  let best = ',', bestCount = -1;
  candidates.forEach(d => {
    const count = sampleLine.split(d).length - 1;
    if (count > bestCount) { bestCount = count; best = d; }
  });
  return bestCount > 0 ? best : ',';
}

/**
 * RFC4180-ish single-line CSV/TSV cell splitter: a quoted field may contain
 * the delimiter verbatim, and `""` inside a quoted field is an escaped `"`.
 * Multi-line quoted fields are out of scope (the streaming engine splits on
 * newlines before this ever runs) — a line with an unterminated quote is
 * reported as malformed (returns null) rather than silently misparsed.
 * Unquoted cells are trimmed; quoted cell content is preserved verbatim.
 */
export function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  let cellWasQuoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' && cur.length === 0 && !cellWasQuoted) {
      inQuotes = true;
      cellWasQuoted = true;
      continue;
    }
    if (c === delimiter) {
      cells.push(cellWasQuoted ? cur : cur.trim());
      cur = '';
      cellWasQuoted = false;
      continue;
    }
    cur += c;
  }
  if (inQuotes) return null; // unterminated quoted field — likely spans a newline, unsupported
  cells.push(cellWasQuoted ? cur : cur.trim());
  return cells;
}

// Operational states that a free-text "status"-named column may legitimately
// hold without indicating an alarm. Only applied when no dedicated
// alarm/fault column exists — see alarmColumnGuess below.
const NORMAL_STATUS_VALUES = new Set(['OK', 'NORMAL', 'CHARGING', 'DISCHARGING', 'IDLE', 'STANDBY', 'RUNNING', 'READY', '0']);

function isStatusOnlyColumn(columnName) {
  const c = columnName || '';
  return /status/i.test(c) && !/alarm|fault/i.test(c);
}

/* ---- Generic single-header-row CSV/TSV (typical BMS/EMS export) ---- */
export const GENERIC_FORMAT = {
  id: 'generic',
  label: '일반 CSV/TSV',
  isCommentRow: () => false,
  isHeaderRow: (line, acc) => acc.columns === null,
  isDataRow: (line, acc) => acc.columns !== null,
  parseHeaderRow(line) {
    const delimiter = detectDelimiter(line);
    const cells = parseDelimitedLine(line, delimiter);
    return { columns: cells || [], colOffset: 0, delimiter };
  },
  parseDataRow(line, acc) {
    return parseDelimitedLine(line, acc.delimiter);
  },
  entityColumnGuess: () => null,
  timestampColumnGuess: (columns) => columns.find(c => /^(timestamp|time|date)/i.test(c)) || null,
  isTimestampLikeColumn: (c) => /^(timestamp|time|date)/i.test(c),
  // Prefer an explicit alarm/fault column over a generic status column — a
  // status column reflects normal operating state most of the time, while
  // an alarm/fault column's non-zero values are inherently exceptional.
  alarmColumnGuess: (columns) => columns.find(c => /alarm|fault/i.test(c)) || columns.find(c => /status/i.test(c)) || null,
  isAlarmValue(v, columnName) {
    const s = (v || '').trim();
    if (!s) return false;
    if (isStatusOnlyColumn(columnName)) {
      // Free-text operational status: only values outside the known-normal
      // set count as an alarm (so "Charging"/"Idle"/... don't get flagged).
      return !NORMAL_STATUS_VALUES.has(s.toUpperCase());
    }
    // Dedicated alarm/fault code column: any non-zero/non-OK/NORMAL value is
    // itself an alarm code (e.g. "OV001"), so keep the strict rule.
    return s !== '0' && s.toUpperCase() !== 'OK' && s.toUpperCase() !== 'NORMAL';
  }
};

/* ---- AEMO MMS standard report CSV (C=comment / I=header / D=data rows) ----
   Real columns start at field index 4 (RECORDTYPE, DATA_STREAM, TABLE, VERSION
   prefix fields precede them) — a fixed, well-known layout across AEMO MMS
   CSV extracts, e.g.:
     C,SETP.WORLD,NEXT_DAY_FPPMW,AEMO,PUBLIC,2025/08/17,...
     I,FPP,UNIT_MW,1,INTERVAL_DATETIME,MEASUREMENT_DATETIME,FPP_UNITID,...
     D,FPP,UNIT_MW,1,"2025/08/16 04:05:00","2025/08/16 04:00:04",ADPBA1,...
*/
const AEMO_COL_OFFSET = 4;

export const AEMO_MMS_FORMAT = {
  id: 'aemo-mms',
  label: 'AEMO MMS 리포트',
  isCommentRow: (line) => line.startsWith('C,'),
  isHeaderRow: (line) => line.startsWith('I,'),
  isDataRow: (line) => line.startsWith('D,'),
  parseHeaderRow(line) {
    const cells = parseDelimitedLine(line, ',') || [];
    return { columns: cells.slice(AEMO_COL_OFFSET), colOffset: AEMO_COL_OFFSET, delimiter: ',' };
  },
  parseDataRow(line) {
    return parseDelimitedLine(line, ',');
  },
  entityColumnGuess(columns) {
    if (columns.includes('PARTICIPANTID')) return 'PARTICIPANTID';
    if (columns.includes('FPP_UNITID')) return 'FPP_UNITID';
    return null;
  },
  timestampColumnGuess(columns) {
    if (columns.includes('MEASUREMENT_DATETIME')) return 'MEASUREMENT_DATETIME';
    if (columns.includes('INTERVAL_DATETIME')) return 'INTERVAL_DATETIME';
    return null;
  },
  isTimestampLikeColumn: (c) => /DATETIME/i.test(c),
  alarmColumnGuess: (columns) => (columns.includes('MW_QUALITY_FLAG') ? 'MW_QUALITY_FLAG' : null),
  isAlarmValue(v) {
    const s = (v || '').trim();
    return !!s && s !== '1'; // 1=정상, 2=대체/추정치, 0=불량
  }
};

const KNOWN_FORMATS = [AEMO_MMS_FORMAT, GENERIC_FORMAT];

/** Given the first few non-empty raw lines of a source, pick the best-fit format adapter. */
export function detectFormat(firstLines) {
  const l0 = (firstLines[0] || '').trim();
  const l1 = (firstLines[1] || '').trim();
  if (AEMO_MMS_FORMAT.isCommentRow(l0) && AEMO_MMS_FORMAT.isHeaderRow(l1)) return AEMO_MMS_FORMAT;
  return GENERIC_FORMAT;
}

export function formatById(id) {
  return KNOWN_FORMATS.find(f => f.id === id) || GENERIC_FORMAT;
}
