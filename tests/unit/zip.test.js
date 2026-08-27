import test from 'node:test';
import assert from 'node:assert/strict';
import { formatZipEntryError, markSourceError, normalizeZipSize, isMacosArtifactPath } from '../../src/zip.js';

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
