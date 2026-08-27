import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  extractHtmlText, extractPptxText, capDocText, buildReferenceDocsBlock,
  MAX_CHARS_PER_DOC, MAX_TOTAL_REFERENCE_CHARS
} from '../../src/reference-docs.js';

test('extractHtmlText strips script/style blocks and tags, decodes entities', () => {
  const html = `<html><head><style>.a{color:red}</style><script>alert('x')</script></head>
    <body><h1>과전압 &amp; 자동 차단</h1><p>랙 #3&nbsp;점검 결과</p></body></html>`;
  const text = extractHtmlText(html);
  assert.doesNotMatch(text, /alert|color:red/);
  assert.match(text, /과전압 & 자동 차단/);
  assert.match(text, /랙 #3 점검 결과/);
});

test('extractHtmlText handles numeric entities', () => {
  assert.equal(extractHtmlText('<p>A&#38;B&#x26;C</p>').trim(), 'A&B&C');
});

test('extractPptxText reads <a:t> runs from ppt/slides/slide*.xml in slide order', async () => {
  const zip = new JSZip();
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>두 번째 슬라이드</a:t></p:sld>');
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>첫 </a:t><a:t>번째 슬라이드</a:t></p:sld>');
  zip.file('ppt/slideLayouts/slideLayout1.xml', '<a:t>레이아웃 텍스트(무시되어야 함)</a:t>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const text = await extractPptxText(JSZip, buf);
  const lines = text.split('\n');
  assert.equal(lines[0], '첫 번째 슬라이드');
  assert.equal(lines[1], '두 번째 슬라이드');
  assert.doesNotMatch(text, /레이아웃/);
});

test('capDocText truncates at MAX_CHARS_PER_DOC and reports truncation, never silently', () => {
  const short = capDocText('짧은 텍스트');
  assert.equal(short.truncated, false);

  const long = capDocText('가'.repeat(MAX_CHARS_PER_DOC + 500));
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, MAX_CHARS_PER_DOC);
});

test('buildReferenceDocsBlock labels each excerpt with its source filename', () => {
  const { text, truncation } = buildReferenceDocsBlock([
    { name: 'case-01.pptx', text: '2024년 3월 랙#1 과전압, 셀 밸런싱 오작동으로 판정.' },
    { name: 'case-02.html', text: '2023년 12월 랙#5 과전류, PCS 제어 오차로 판정.' }
  ]);
  assert.match(text, /\[참고 파일: case-01\.pptx\]/);
  assert.match(text, /\[참고 파일: case-02\.html\]/);
  assert.equal(truncation.excludedDocs, 0);
  assert.equal(truncation.textTruncatedChars, 0);
});

test('buildReferenceDocsBlock enforces the total budget across all docs combined, reporting what was cut', () => {
  const bigDoc = { name: 'huge.html', text: '가'.repeat(MAX_TOTAL_REFERENCE_CHARS) };
  const secondDoc = { name: 'second.html', text: '이 문서는 완전히 생략되어야 합니다.' };
  const { text, truncation } = buildReferenceDocsBlock([bigDoc, secondDoc]);
  assert.ok(text.length <= MAX_TOTAL_REFERENCE_CHARS + 200); // small allowance for label + truncation-note suffix
  assert.equal(truncation.excludedDocs, 1);
  assert.ok(truncation.textTruncatedChars > 0);
  assert.doesNotMatch(text, /완전히 생략되어야 합니다/);
});

test('buildReferenceDocsBlock returns empty text and zero truncation for no docs', () => {
  const { text, truncation } = buildReferenceDocsBlock([]);
  assert.equal(text, '');
  assert.equal(truncation.excludedDocs, 0);
  assert.equal(truncation.textTruncatedChars, 0);
});
