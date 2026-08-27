import test from 'node:test';
import assert from 'node:assert/strict';
import { formatZipEntryError, markSourceError } from '../../src/zip.js';

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
