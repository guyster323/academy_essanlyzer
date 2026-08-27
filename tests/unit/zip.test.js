import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { formatZipEntryError, markSourceError, normalizeZipSize, isMacosArtifactPath, persistBrowserFile } from '../../src/zip.js';
import * as zipModule from '../../src/zip.js';
import { zipEntryByteChunks, getPersistedFileBytes } from '../../src/log-engine.js';
import { GENERIC_FORMAT } from '../../src/formats.js';

const TEST_ENTRY_NAME = 'field_data/data_sys_6.csv';
const TEST_CSV = 'timestamp,voltage_V,alarm_code\n' +
  '2025-01-01T00:00:00Z,3.30,0\n' +
  '2025-01-01T00:00:05Z,3.31,0\n';
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UINT32_MAX = 0xffffffff;

class MemoryArchive {
  constructor(bytes) {
    this.bytes = new Uint8Array(bytes);
    this.size = this.bytes.byteLength;
  }

  slice(start, end) {
    const bytes = this.bytes.slice(start, end === undefined ? this.size : end);
    return {
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
  }
}

function findCentralDirectoryEntry(bytes) {
  for (let i = bytes.length - 4; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) {
      return i;
    }
  }
  throw new Error('synthetic ZIP central directory entry not found');
}

function findEocdOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = view.getUint16(i + 20, true);
    if (i + 22 + commentLength === bytes.byteLength) return i;
  }
  throw new Error('synthetic ZIP EOCD not found');
}

function centralDirectoryRecords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocdOffset(bytes);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const records = [];
  let cursor = centralOffset;
  while (cursor + 46 <= eocdOffset && view.getUint32(cursor, true) === CENTRAL_FILE_HEADER_SIGNATURE) {
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraFieldLength = view.getUint16(cursor + 30, true);
    const fileCommentLength = view.getUint16(cursor + 32, true);
    const recordLength = 46 + fileNameLength + extraFieldLength + fileCommentLength;
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + fileNameLength));
    records.push({ offset: cursor, length: recordLength, name });
    cursor += recordLength;
  }
  return { eocdOffset, centralOffset, records };
}

function setUint64(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

async function makeZip64Zip() {
  const zip = new JSZip();
  zip.file(TEST_ENTRY_NAME, TEST_CSV, { createFolders: false });
  const classicBytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const { eocdOffset, centralOffset } = centralDirectoryRecords(classicBytes);
  const classicCentral = classicBytes.slice(centralOffset, eocdOffset);
  const classicCentralView = new DataView(classicCentral.buffer, classicCentral.byteOffset, classicCentral.byteLength);
  const fileNameLength = classicCentralView.getUint16(28, true);
  const zip64ExtraLength = 4 + 8 + 8 + 8;
  const zip64Central = new Uint8Array(classicCentral.length + zip64ExtraLength);
  zip64Central.set(classicCentral.subarray(0, 46 + fileNameLength), 0);
  zip64Central.set(classicCentral.subarray(46 + fileNameLength), 46 + fileNameLength + zip64ExtraLength);
  const zip64CentralView = new DataView(zip64Central.buffer, zip64Central.byteOffset, zip64Central.byteLength);
  zip64CentralView.setUint32(20, UINT32_MAX, true);
  zip64CentralView.setUint32(24, UINT32_MAX, true);
  zip64CentralView.setUint16(30, zip64ExtraLength, true);
  zip64CentralView.setUint32(42, UINT32_MAX, true);
  const extraOffset = 46 + fileNameLength;
  zip64CentralView.setUint16(extraOffset, 0x0001, true);
  zip64CentralView.setUint16(extraOffset + 2, 24, true);
  setUint64(zip64CentralView, extraOffset + 4, new TextEncoder().encode(TEST_CSV).byteLength);
  const compressedSize = classicCentralView.getUint32(20, true);
  setUint64(zip64CentralView, extraOffset + 12, compressedSize);
  setUint64(zip64CentralView, extraOffset + 20, 0);

  const localAndData = classicBytes.slice(0, centralOffset);
  const zip64RecordOffset = localAndData.length + zip64Central.length;
  const zip64Record = new Uint8Array(56);
  const zip64RecordView = new DataView(zip64Record.buffer);
  zip64RecordView.setUint32(0, 0x06064b50, true);
  zip64RecordView.setUint32(4, 44, true);
  zip64RecordView.setUint16(12, 45, true);
  zip64RecordView.setUint16(14, 45, true);
  zip64RecordView.setUint32(16, 0, true);
  zip64RecordView.setUint32(20, 0, true);
  setUint64(zip64RecordView, 24, 1);
  setUint64(zip64RecordView, 32, 1);
  setUint64(zip64RecordView, 40, zip64Central.length);
  setUint64(zip64RecordView, 48, centralOffset);

  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setUint32(4, 0, true);
  setUint64(locatorView, 8, zip64RecordOffset);
  locatorView.setUint32(16, 1, true);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, 0xffff, true);
  eocdView.setUint16(10, 0xffff, true);
  eocdView.setUint32(12, UINT32_MAX, true);
  eocdView.setUint32(16, UINT32_MAX, true);
  eocdView.setUint16(20, 0, true);

  const bytes = new Uint8Array(localAndData.length + zip64Central.length + zip64Record.length + locator.length + eocd.length);
  let offset = 0;
  for (const part of [localAndData, zip64Central, zip64Record, locator, eocd]) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const loaded = await JSZip.loadAsync(bytes);
  return {
    entry: loaded.files[TEST_ENTRY_NAME],
    archiveFile: new MemoryArchive(bytes),
    expectedBytes: new TextEncoder().encode(TEST_CSV)
  };
}

async function makePrependedZip() {
  const zip = new JSZip();
  zip.file(TEST_ENTRY_NAME, TEST_CSV);
  const original = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const loaded = await JSZip.loadAsync(original);
  const prefix = new TextEncoder().encode('SFX-PREFIX');
  const bytes = new Uint8Array(prefix.length + original.length);
  bytes.set(prefix, 0);
  bytes.set(original, prefix.length);
  return {
    entry: loaded.files[TEST_ENTRY_NAME],
    archiveFile: new MemoryArchive(bytes),
    expectedBytes: new TextEncoder().encode(TEST_CSV)
  };
}

async function makePrependedZip64() {
  const { entry, archiveFile, expectedBytes } = await makeZip64Zip();
  const prefix = new TextEncoder().encode('ZIP64-SFX-PREFIX');
  const bytes = new Uint8Array(prefix.length + archiveFile.bytes.length);
  bytes.set(prefix, 0);
  bytes.set(archiveFile.bytes, prefix.length);
  return { entry, archiveFile: new MemoryArchive(bytes), expectedBytes };
}

async function makeDataDescriptorZip() {
  const zip = new JSZip();
  zip.file(TEST_ENTRY_NAME, TEST_CSV, { createFolders: false });
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles: true }));
  const loaded = await JSZip.loadAsync(bytes);
  return {
    entry: loaded.files[TEST_ENTRY_NAME],
    archiveFile: new MemoryArchive(bytes),
    expectedBytes: new TextEncoder().encode(TEST_CSV)
  };
}

async function makeHighRatioZip() {
  const payload = new Uint8Array(16 * 1024 * 1024);
  const zip = new JSZip();
  zip.file('high-ratio.csv', payload, { createFolders: false });
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const loaded = await JSZip.loadAsync(bytes);
  return { entry: loaded.files['high-ratio.csv'], archiveFile: new MemoryArchive(bytes), expectedBytes: payload };
}

async function makeCentralCommentZip() {
  const zip = new JSZip();
  zip.file('comment-target.csv', 'COMMENT-TARGET', { createFolders: false, compression: 'STORE' });
  const original = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
  const { eocdOffset, centralOffset } = centralDirectoryRecords(original);
  const originalCentral = original.slice(centralOffset, eocdOffset);
  const comment = new Uint8Array([0x50, 0x4b, 0x05, 0x05, 0x00, 0x00]);
  const central = new Uint8Array(originalCentral.length + comment.length);
  central.set(originalCentral, 0);
  central.set(comment, originalCentral.length);
  new DataView(central.buffer).setUint16(32, comment.length, true);
  const eocd = original.slice(eocdOffset);
  new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength).setUint32(12, central.length, true);
  const bytes = new Uint8Array(centralOffset + central.length + eocd.length);
  bytes.set(original.slice(0, centralOffset), 0);
  bytes.set(central, centralOffset);
  bytes.set(eocd, centralOffset + central.length);
  const loaded = await JSZip.loadAsync(original);
  return {
    entry: loaded.files['comment-target.csv'],
    archiveFile: new MemoryArchive(bytes),
    expectedBytes: new TextEncoder().encode('COMMENT-TARGET')
  };
}

async function makeMisbindingZip() {
  const zip = new JSZip();
  zip.file('target.csv', 'TARGET', { compression: 'STORE' });
  zip.file('sibling.csv', 'EVIL!!', { compression: 'STORE' });
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
  const loaded = await JSZip.loadAsync(bytes);
  const { records } = centralDirectoryRecords(bytes);
  const target = records.find(record => record.name === 'target.csv');
  const sibling = records.find(record => record.name === 'sibling.csv');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(target.offset + 42, view.getUint32(sibling.offset + 42, true), true);
  return { entry: loaded.files['target.csv'], archiveFile: new MemoryArchive(bytes) };
}

function addComment(bytes, comment) {
  const eocdOffset = findEocdOffset(bytes);
  const result = new Uint8Array(bytes.length + comment.length);
  result.set(bytes, 0);
  result.set(comment, bytes.length);
  new DataView(result.buffer).setUint16(eocdOffset + 20, comment.length, true);
  return result;
}

async function makeBrokenZip(rawCentralUncompressedSize) {
  const zip = new JSZip();
  zip.file(TEST_ENTRY_NAME, TEST_CSV);
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const centralOffset = findCentralDirectoryEntry(bytes);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(centralOffset + 24, rawCentralUncompressedSize, true);
  const loaded = await JSZip.loadAsync(bytes);
  return {
    entry: loaded.files[TEST_ENTRY_NAME],
    archiveFile: new MemoryArchive(bytes),
    expectedBytes: new TextEncoder().encode(TEST_CSV)
  };
}

async function collectBytes(iterable) {
  const parts = [];
  let total = 0;
  for await (const chunk of iterable) {
    assert.ok(chunk instanceof Uint8Array);
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

test('formatZipEntryError explains JSZip uncompressed-size mismatch as an entry-level failure', () => {
  const message = formatZipEntryError(new Error('Bug : uncompressed data size mismatch'));
  assert.match(message, /압축 해제 데이터 길이 불일치/);
  assert.match(message, /해당 항목만/);
});

test('markSourceError keeps a corrupt source visible as error without changing sibling work', () => {
  const source = { status: 'processing', errorMsg: '' };
  markSourceError(source, new Error('entry failed'));
  assert.equal(source.status, 'error');
  assert.match(source.errorMsg, /entry failed/);
});

test('normalizeZipSize recovers a 32-bit-signed-wrapped entry size (reproduced on a real ~2.75GB CSV entry)', () => {
  assert.equal(normalizeZipSize(-1405782333), 2889184963);
});

test('normalizeZipSize leaves an in-range size untouched', () => {
  assert.equal(normalizeZipSize(734_890_000), 734_890_000);
});

test('zipEntryByteChunks bypasses JSZip signed-size validation with a local-header streaming fallback', async () => {
  const { entry, archiveFile, expectedBytes } = await makeBrokenZip(0x80000000);
  assert.ok(entry._data.uncompressedSize < 0);

  const actualBytes = await collectBytes(zipEntryByteChunks(entry, archiveFile));
  assert.deepEqual(actualBytes, expectedBytes);
});

test('ZIP fallback reads ZIP64 central-directory fields at their specified offsets', async () => {
  const { entry, archiveFile, expectedBytes } = await makeZip64Zip();

  const actualBytes = await collectBytes(zipEntryByteChunks(entry, archiveFile, { forceDirect: true }));
  assert.deepEqual(actualBytes, expectedBytes);
});

test('ZIP fallback applies the prepended archive base offset to local headers', async () => {
  const { entry, archiveFile, expectedBytes } = await makePrependedZip();

  const actualBytes = await collectBytes(zipEntryByteChunks(entry, archiveFile, { forceDirect: true }));
  assert.deepEqual(actualBytes, expectedBytes);
});

test('ZIP64 fallback applies the prepended archive base offset to local headers', async () => {
  const { entry, archiveFile, expectedBytes } = await makePrependedZip64();

  const actualBytes = await collectBytes(zipEntryByteChunks(entry, archiveFile, { forceDirect: true }));
  assert.deepEqual(actualBytes, expectedBytes);
});

test('ZIP fallback uses central sizes when the local header uses a data descriptor', async () => {
  const { entry, archiveFile, expectedBytes } = await makeDataDescriptorZip();

  const actualBytes = await collectBytes(zipEntryByteChunks(entry, archiveFile, { forceDirect: true }));
  assert.deepEqual(actualBytes, expectedBytes);
});

test('ZIP fallback accepts a valid high-ratio deflate entry without exceeding the output queue bound', async () => {
  const { entry, archiveFile, expectedBytes } = await makeHighRatioZip();

  const actualBytes = await collectBytes(zipEntryByteChunks(entry, archiveFile, { forceDirect: true }));
  assert.deepEqual(actualBytes, expectedBytes);
});

test('ZIP fallback does not mistake a central-file comment for a digital-signature trailer', async () => {
  const { entry, archiveFile, expectedBytes } = await makeCentralCommentZip();

  const actualBytes = await collectBytes(zipEntryByteChunks(entry, archiveFile, { forceDirect: true }));
  assert.deepEqual(actualBytes, expectedBytes);
});

test('ZIP fallback binds the local filename to the selected central record', async () => {
  const { entry, archiveFile } = await makeMisbindingZip();

  await assert.rejects(
    collectBytes(zipEntryByteChunks(entry, archiveFile, { forceDirect: true })),
    /local\/central file name mismatch/
  );
});

test('ZIP fallback ignores a false EOCD signature embedded in the ZIP comment', async () => {
  const { entry, archiveFile, expectedBytes } = await makeBrokenZip(0x80000000);
  const comment = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x01, 0x02]);
  const bytesWithComment = addComment(archiveFile.bytes, comment);
  const actualBytes = await collectBytes(zipEntryByteChunks(entry, new MemoryArchive(bytesWithComment)));

  assert.deepEqual(actualBytes, expectedBytes);
});

test('probeSource uses the same fallback when a bounded ZIP prefix reaches the JSZip mismatch', async () => {
  const { entry, archiveFile } = await makeBrokenZip(0x80000000);
  const probe = await zipModule.probeSource({ type: 'zipEntry', entry, archiveFile });

  assert.equal(probe.error, null);
  assert.equal(probe.format.id, 'generic');
  assert.equal(probe.entityColumn, null);
});

test('streamZipEntryIntoSource retries from byte zero after a positive-size JSZip mismatch', async () => {
  const { entry, archiveFile, expectedBytes } = await makeBrokenZip(1);
  const source = {
    name: TEST_ENTRY_NAME,
    encoding: 'utf-8',
    format: GENERIC_FORMAT,
    entityFilter: '',
    processedBytes: 0
  };

  await zipModule.streamZipEntryIntoSource(
    source,
    { type: 'zipEntry', entry, archiveFile },
    () => {}
  );

  assert.equal(source.processedBytes, expectedBytes.byteLength);
  assert.equal(source.rowCount, 2);
  assert.equal(source.status, 'ready');
});

test('isMacosArtifactPath flags a __MACOSX AppleDouble sidecar next to a same-extension real file (reproduced on a real macOS-zipped public dataset)', () => {
  assert.equal(isMacosArtifactPath('__MACOSX/field_data/._data_sys_6.csv'), true);
  assert.equal(isMacosArtifactPath('field_data/data_sys_6.csv'), false);
});

test('isMacosArtifactPath flags an inline AppleDouble file outside a __MACOSX tree', () => {
  assert.equal(isMacosArtifactPath('field_data/._data_sys_6.csv'), true);
});

test('isMacosArtifactPath flags entries under a __MACOSX folder reached via a nested-zip path', () => {
  assert.equal(isMacosArtifactPath('outer.zip/__MACOSX/data.csv'), true);
  assert.equal(isMacosArtifactPath('outer.zip/field_data/data.csv'), false);
});

test('persistBrowserFile copies bytes so later reads do not depend on the original File handle', async () => {
  const original = new File(['hello,world\n'], 'x.csv', { type: 'text/csv' });
  const owned = await persistBrowserFile(original);
  assert.equal(owned.name, 'x.csv');
  const persisted = getPersistedFileBytes(owned);
  assert.ok(persisted);
  assert.equal(new TextDecoder().decode(persisted), 'hello,world\n');
});
