import JSZip from 'jszip';
import { state } from './state.js';
import { render } from './render.js';
import { scheduleAutoDetect } from './pipeline.js';
import {
  LOG_EXT_ALLOW, LOG_EXT_SKIP_NOTE, LARGE_FILE_WARN_BYTES,
  formatBytes, detectEncodingFromBytes, zipEntryByteChunks, fileByteChunks,
  streamIntoSource, makeAccumulator, feedLine, isJsZipUncompressedSizeMismatch,
  attachPersistedFileBytes, getPersistedFileBytes
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

export function formatZipEntryError(error) {
  const raw = String(error?.message || error || '알 수 없는 압축 항목 오류');
  const detail = raw.slice(0, 300);
  if (/uncompressed data size mismatch/i.test(raw)) {
    return `ZIP 항목 오류: 압축 해제 데이터 길이 불일치 — 해당 항목만 오류 상태로 표시하고 나머지 항목은 계속 처리합니다 (${detail})`;
  }
  return `ZIP 항목 처리 실패 — 해당 항목만 오류 상태로 표시하고 나머지 항목은 계속 처리합니다 (${detail})`;
}

export function markSourceError(src, error) {
  src.status = 'error';
  src.errorMsg = formatZipEntryError(error);
  return src;
}

// JSZip reads 32-bit size fields with bitwise ops that produce a signed
// result in JS — any entry whose real size is >= 2^31 bytes (~2GB, well
// within the classic zip format's 4GB cap) comes back negative. Reproduced
// live against a ~2.75GB entry in a real public dataset archive. Recover the
// intended unsigned value instead of showing/using a nonsensical negative
// byte count.
export function normalizeZipSize(size) {
  return size < 0 ? size + 4294967296 : size;
}

// macOS Archive Utility artifacts: a "__MACOSX/" mirror tree of AppleDouble
// resource-fork sidecar files (e.g. "__MACOSX/dir/._real.csv" next to
// "dir/real.csv"). These keep the real file's extension, so they pass the
// .csv/.txt allow-list and get queued as if they were real logs — but their
// content is a small binary resource-fork blob, not text, so streaming them
// can hang indefinitely and block the whole catalog (reproduced live against
// a real macOS-zipped public dataset). Detected by name alone, independent
// of extension, so it runs before any extension-based decision.
export function isMacosArtifactPath(fullPath) {
  const segments = fullPath.split('/');
  const baseName = segments[segments.length - 1] || '';
  return segments.includes('__MACOSX') || baseName.startsWith('._');
}

function makeSourceShell(name, path, sizeBytes, origin, ref) {
  return {
    id: 'SRC-' + (++sourceIdCounter),
    name, path: path || name, origin,
    sizeBytes: sizeBytes || 0, sizeLabel: formatBytes(sizeBytes || 0),
    status: 'cataloged', errorMsg: '',
    encoding: 'utf-8', encodingAuto: true,
    format: GENERIC_FORMAT,
    delimiter: ',', columns: [],
    rowCount: 0, alarmCount: 0, malformedRowCount: 0, droppedResistanceEvents: 0,
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
async function collectZipPrefix(ref) {
  const parts = [];
  let total = 0;

  const collect = async (options) => {
    parts.length = 0;
    total = 0;
    for await (const chunk of zipEntryByteChunks(ref.entry, ref.archiveFile, options)) {
      parts.push(chunk);
      total += chunk.length;
      if (total >= PROBE_BYTES) break;
    }
  };

  try {
    await collect();
  } catch (error) {
    if (!ref.archiveFile || !isJsZipUncompressedSizeMismatch(error)) throw error;
    await collect({ forceDirect: true });
  }
  return concatUint8(parts);
}

export async function probeSource(ref) {
  let headBytes;
  try {
    if (ref.type === 'file') {
      const persisted = getPersistedFileBytes(ref.file);
      if (persisted) {
        headBytes = persisted.subarray(0, Math.min(PROBE_BYTES, persisted.byteLength));
      } else {
        const buf = await ref.file.slice(0, PROBE_BYTES).arrayBuffer();
        headBytes = new Uint8Array(buf);
      }
    } else if (ref.type === 'zipEntry') {
      headBytes = await collectZipPrefix(ref);
    }
  } catch (e) {
    return { encoding: 'utf-8', format: GENERIC_FORMAT, entityColumn: null, entityFilterSuggestion: '', error: e };
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

  return { encoding, format, entityColumn: acc.entityColumn, entityFilterSuggestion, error: null };
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

  if (probe.error) {
    markSourceError(src, probe.error);
    render();
    return src;
  }

  if (sizeBytes > 0 && sizeBytes <= CATALOG_AUTOSTREAM_THRESHOLD_BYTES) {
    await startSourceProcessing(src.id);
  } else {
    src.status = 'cataloged';
    render();
  }
  return src;
}

async function catalogZipEntries(zip, pathPrefix, depth, archiveFile) {
  const entries = Object.values(zip.files).filter(f => !f.dir);

  for (const entry of entries) {
    const ext = (entry.name.split('.').pop() || '').toLowerCase();
    const baseName = entry.name.split('/').pop();
    const fullPath = pathPrefix ? pathPrefix + '/' + entry.name : entry.name;

    if (isMacosArtifactPath(fullPath)) {
      state.zipSkipped.push({ name: fullPath, reason: 'macOS 리소스 포크 부속 파일(AppleDouble) — 분석 대상 아님' });
      continue;
    }

    if (ext === 'zip') {
      if (depth >= NESTED_ZIP_MAX_DEPTH) {
        state.zipSkipped.push({ name: fullPath, reason: `중첩 zip 깊이 제한(${NESTED_ZIP_MAX_DEPTH}단계) 초과 — 건너뜀` });
        continue;
      }
      const compSize = normalizeZipSize((entry._data && entry._data.compressedSize) || 0);
      if (compSize > NESTED_ZIP_BUFFER_LIMIT) {
        state.zipSkipped.push({ name: fullPath, reason: `중첩 zip 용량(${formatBytes(compSize)})이 처리 한도(${formatBytes(NESTED_ZIP_BUFFER_LIMIT)})를 초과해 건너뜀` });
        continue;
      }
      render();
      try {
        const buf = await entry.async('arraybuffer');
        const innerZip = await JSZip.loadAsync(buf);
        await catalogZipEntries(innerZip, fullPath, depth + 1, new Blob([buf]));
      } catch (e) {
        console.error(e);
        state.zipSkipped.push({ name: fullPath, reason: formatZipEntryError(e), level: 'error' });
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

    const sizeBytes = normalizeZipSize((entry._data && entry._data.uncompressedSize) || 0);
    render();
    try {
      await catalogOneEntry(baseName, fullPath, sizeBytes, { type: 'zipEntry', entry, archiveFile });
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
      await streamZipEntryIntoSource(src, src._ref, throttledProgress);
    }
  } catch (e) {
    console.error(e);
    markSourceError(src, e);
  }
  render();
}

export async function streamZipEntryIntoSource(src, ref, onProgress) {
  try {
    await streamIntoSource(src, zipEntryByteChunks(ref.entry, ref.archiveFile), onProgress);
  } catch (error) {
    if (!ref.archiveFile || !isJsZipUncompressedSizeMismatch(error)) throw error;
    src.processedBytes = 0;
    await streamIntoSource(
      src,
      zipEntryByteChunks(ref.entry, ref.archiveFile, { forceDirect: true }),
      onProgress
    );
  }
}

export async function startSourceProcessing(id) {
  const src = state.logSources.find(s => s.id === id);
  // Shells start as 'cataloged'. 'processing' means a stream is already in flight.
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

// <input type=file> File objects can hang on slice()/arrayBuffer() after
// render() replaces the input (reproduced: Case A CSV stuck at 0% / 3.10MB
// in Chrome, Orca, and Playwright). Detach a Blob copy before any re-render.
export async function persistBrowserFile(file) {
  if (!file) return null;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const owned = new File([bytes], file.name, {
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now()
  });
  attachPersistedFileBytes(owned, bytes);
  return owned;
}

export async function handleCsvFileUpload(evt) {
  const raw = Array.from(evt.target.files || []);
  const files = [];
  for (const file of raw) {
    const owned = await persistBrowserFile(file);
    if (owned) files.push(owned);
  }
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
  const file = await persistBrowserFile(evt.target.files[0]);
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
    await catalogZipEntries(zip, '', 0, file);
  } catch (e) {
    console.error(e);
    state.zipSkipped.push({ name: file.name, reason: formatZipEntryError(e), level: 'error' });
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
