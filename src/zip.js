import JSZip from 'jszip';
import { state } from './state.js';
import { render } from './render.js';
import { scheduleAutoDetect } from './pipeline.js';
import {
  LOG_EXT_ALLOW, LOG_EXT_SKIP_NOTE, LARGE_FILE_WARN_BYTES,
  formatBytes, detectEncodingFromBytes, zipEntryByteChunks, fileByteChunks,
  streamIntoSource, makeAccumulator, feedLine
} from './log-engine.js';
import { detectFormat, GENERIC_FORMAT } from './formats.js';

/* Entries at/under this size stream immediately on catalog, matching the
   original "drop a small CSV in" convenience. Larger entries (e.g. the
   ~520MB-per-day AEMO CSVs) are only catalogued (name/size/format known)
   until the user explicitly opts in — see plan decision on large archives. */
const CATALOG_AUTOSTREAM_THRESHOLD_BYTES = 20 * 1024 * 1024;
const NESTED_ZIP_BUFFER_LIMIT = 300 * 1024 * 1024;  // max compressed size of an inner zip we'll buffer
const NESTED_ZIP_MAX_DEPTH = 2;
const PROBE_BYTES = 512 * 1024; // enough to see a header + a few thousand data rows

let sourceIdCounter = 0;

function makeSourceShell(name, path, sizeBytes, origin, ref) {
  return {
    id: 'SRC-' + (++sourceIdCounter),
    name, path: path || name, origin,
    sizeBytes: sizeBytes || 0, sizeLabel: formatBytes(sizeBytes || 0),
    status: 'processing', errorMsg: '',
    encoding: 'utf-8', encodingAuto: true,
    format: GENERIC_FORMAT,
    delimiter: ',', columns: [],
    rowCount: 0, alarmCount: 0, malformedRowCount: 0,
    headSample: [], alarmSamples: [], groups: null,
    entityColumn: null, entityFilter: '', entityFilterAuto: true,
    timestampColumn: null,
    stats: {}, processedBytes: 0,
    score: 0, selected: false, showPreview: false,
    _ref: ref
  };
}

function concatUint8(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Peeks a small prefix of a source (without full streaming) to determine
 *  encoding, log format, and — for formats with a groupable entity column —
 *  whether a BESS-like value is present, to auto-suggest an entity filter. */
async function probeSource(ref) {
  let headBytes;
  try {
    if (ref.type === 'file') {
      const buf = await ref.file.slice(0, PROBE_BYTES).arrayBuffer();
      headBytes = new Uint8Array(buf);
    } else if (ref.type === 'zipEntry') {
      const parts = [];
      let total = 0;
      for await (const chunk of zipEntryByteChunks(ref.entry)) {
        parts.push(chunk);
        total += chunk.length;
        if (total >= PROBE_BYTES) break;
      }
      headBytes = concatUint8(parts);
    }
  } catch (e) {
    return { encoding: 'utf-8', format: GENERIC_FORMAT, entityColumn: null, entityFilterSuggestion: '' };
  }

  const encoding = detectEncodingFromBytes(headBytes);
  const text = new TextDecoder(encoding === 'euc-kr' ? 'euc-kr' : 'utf-8', { fatal: false }).decode(headBytes);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const format = detectFormat(lines);

  // Reuse the real streaming engine over the probed prefix so entity/grouping
  // detection stays in one place — the trailing line may be cut mid-row,
  // which is fine for a heuristic peek.
  const acc = makeAccumulator(format);
  lines.forEach(l => feedLine(acc, l));

  let entityFilterSuggestion = '';
  if (acc.entityColumn && acc.groups) {
    const hasBess = Object.keys(acc.groups).some(k => k.toUpperCase().includes('BESS'));
    if (hasBess) entityFilterSuggestion = 'BESS';
  }

  return { encoding, format, entityColumn: acc.entityColumn, entityFilterSuggestion };
}

async function catalogOneEntry(name, path, sizeBytes, ref) {
  const src = makeSourceShell(name, path, sizeBytes, 'zip', ref);
  state.logSources.push(src);
  render();

  const probe = await probeSource(ref);
  src.encoding = probe.encoding;
  src.format = probe.format;
  src.entityColumn = probe.entityColumn;
  src.entityFilter = probe.entityFilterSuggestion || '';
  src.entityFilterAuto = true;

  if (sizeBytes > 0 && sizeBytes <= CATALOG_AUTOSTREAM_THRESHOLD_BYTES) {
    await startSourceProcessing(src.id);
  } else {
    src.status = 'cataloged';
    render();
  }
  return src;
}

async function catalogZipEntries(zip, pathPrefix, depth) {
  const entries = Object.values(zip.files).filter(f => !f.dir);

  for (const entry of entries) {
    const ext = (entry.name.split('.').pop() || '').toLowerCase();
    const baseName = entry.name.split('/').pop();
    const fullPath = pathPrefix ? pathPrefix + '/' + entry.name : entry.name;

    if (ext === 'zip') {
      if (depth >= NESTED_ZIP_MAX_DEPTH) {
        state.zipSkipped.push({ name: fullPath, reason: `중첩 zip 깊이 제한(${NESTED_ZIP_MAX_DEPTH}단계) 초과 — 건너뜀` });
        continue;
      }
      const compSize = (entry._data && entry._data.compressedSize) || 0;
      if (compSize > NESTED_ZIP_BUFFER_LIMIT) {
        state.zipSkipped.push({ name: fullPath, reason: `중첩 zip 용량(${formatBytes(compSize)})이 처리 한도(${formatBytes(NESTED_ZIP_BUFFER_LIMIT)})를 초과해 건너뜀` });
        continue;
      }
      render();
      try {
        const buf = await entry.async('arraybuffer');
        const innerZip = await JSZip.loadAsync(buf);
        await catalogZipEntries(innerZip, fullPath, depth + 1);
      } catch (e) {
        console.error(e);
        state.zipSkipped.push({ name: fullPath, reason: '중첩 zip 열기 실패(손상 추정)' });
      }
      continue;
    }

    if (LOG_EXT_SKIP_NOTE.includes(ext)) {
      state.zipSkipped.push({ name: fullPath, reason: '분석 대상 외 파일 형식(.' + ext + ')' });
      continue;
    }
    if (!LOG_EXT_ALLOW.includes(ext)) {
      state.zipSkipped.push({ name: fullPath, reason: '미지원 확장자(.' + (ext || '없음') + ')' });
      continue;
    }

    const sizeBytes = (entry._data && entry._data.uncompressedSize) || 0;
    render();
    try {
      await catalogOneEntry(baseName, fullPath, sizeBytes, { type: 'zipEntry', entry });
    } catch (e) {
      console.error(e);
      state.zipSkipped.push({ name: fullPath, reason: '읽기 실패(바이너리 또는 손상 추정)' });
    }
  }
}

export async function processSource(src) {
  src.status = 'processing';
  src.processedBytes = 0;
  render();
  let lastRender = Date.now();
  const throttledProgress = () => {
    const now = Date.now();
    if (now - lastRender > 180) { lastRender = now; render(); }
  };
  try {
    if (src._ref.type === 'file') {
      await streamIntoSource(src, fileByteChunks(src._ref.file), throttledProgress);
    } else if (src._ref.type === 'zipEntry') {
      await streamIntoSource(src, zipEntryByteChunks(src._ref.entry), throttledProgress);
    }
  } catch (e) {
    console.error(e);
    src.status = 'error';
    src.errorMsg = e.message || String(e);
  }
  render();
}

export async function startSourceProcessing(id) {
  const src = state.logSources.find(s => s.id === id);
  if (!src || src.status === 'processing' || src.status === 'ready') return;
  await processSource(src);
  autoSelectTopCandidates();
  render();
  scheduleAutoDetect();
}

export async function reprocessSource(id, patch) {
  const src = state.logSources.find(s => s.id === id);
  if (!src) return;
  if (patch.encoding !== undefined) { src.encoding = patch.encoding; src.encodingAuto = false; }
  if (patch.entityFilter !== undefined) { src.entityFilter = patch.entityFilter; src.entityFilterAuto = false; }
  await processSource(src);
  autoSelectTopCandidates();
  render();
  scheduleAutoDetect();
}

export function setSourceEncoding(id, value) { reprocessSource(id, { encoding: value }); }
export function setSourceEntityFilter(id, value) { reprocessSource(id, { entityFilter: value }); }

export function autoSelectTopCandidates() {
  const readySources = state.logSources.filter(s => s.status === 'ready');
  if (!readySources.some(s => s.selected)) {
    const best = readySources.filter(s => s.score >= 3);
    (best.length ? best : readySources.slice(0, 1)).forEach(s => s.selected = true);
  }
}

export async function handleCsvFileUpload(evt) {
  const files = Array.from(evt.target.files || []);
  evt.target.value = '';
  for (const file of files) {
    if (file.size > LARGE_FILE_WARN_BYTES) {
      state.zipSkipped.push({ name: file.name, reason: '대용량 파일(' + formatBytes(file.size) + ') — 스트리밍 방식으로 처리되며 다소 시간이 걸릴 수 있습니다.', level: 'info' });
    }
    await catalogOneEntry(file.name, file.name, file.size, { type: 'file', file });
  }
  render();
}

export async function handleZipUpload(evt) {
  const file = evt.target.files[0];
  evt.target.value = '';
  if (!file) return;

  state.zipScanning = true;
  state.zipSkipped = [];
  render();

  if (file.size > LARGE_FILE_WARN_BYTES) {
    state.zipSkipped.push({ name: file.name, reason: 'ZIP 아카이브 용량 ' + formatBytes(file.size) + ' — 목록만 먼저 카탈로그한 뒤, 선택한 항목만 스트리밍 집계합니다.', level: 'info' });
  }

  try {
    const zip = await JSZip.loadAsync(file);
    await catalogZipEntries(zip, '', 0);
  } catch (e) {
    console.error(e);
    state.zipSkipped.push({ name: file.name, reason: 'ZIP 압축 해제 실패 — 파일이 손상되었거나 지원하지 않는 형식입니다.' });
  }

  state.zipScanning = false;
  render();
}

export function toggleSourceSelected(id) {
  const s = state.logSources.find(x => x.id === id);
  if (s) s.selected = !s.selected;
  render();
  scheduleAutoDetect();
}

export function toggleSourcePreview(id) {
  const s = state.logSources.find(x => x.id === id);
  if (s) s.showPreview = !s.showPreview;
  render();
}

export function removeSource(id) {
  state.logSources = state.logSources.filter(x => x.id !== id);
  render();
}
