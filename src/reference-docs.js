/* =========================================================
   REFERENCE DOCS — local text extraction from past-case reference files
   (HTML / PPTX) the engineer explicitly attaches for hypothesis generation.
   Extraction happens entirely client-side; only the extracted, budgeted
   text (never the original file) is sent to the backend. See pipeline.js
   runHypothesisGeneration() for how this feeds into the prompt.
========================================================= */

export const MAX_CHARS_PER_DOC = 20_000;
export const MAX_TOTAL_REFERENCE_CHARS = 60_000;

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
};

function decodeHtmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, ent) ? HTML_ENTITIES[ent] : match;
  });
}

/**
 * Extracts visible text from an HTML document string without a DOM parser
 * (works identically in the browser and under Node's test runner): strips
 * <script>/<style> blocks entirely, strips remaining tags, decodes entities,
 * collapses whitespace.
 */
export function extractHtmlText(html) {
  const withoutScripts = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded.replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function naturalSlideSort(a, b) {
  const na = parseInt((a.match(/slide(\d+)\.xml$/) || [])[1] || '0', 10);
  const nb = parseInt((b.match(/slide(\d+)\.xml$/) || [])[1] || '0', 10);
  return na - nb;
}

/**
 * Extracts slide text from a .pptx (itself a zip of XML parts) — reads only
 * ppt/slides/slide*.xml, in slide order, and pulls text out of <a:t> runs
 * (drawingml text runs). No full XML parser: pptx text runs never nest
 * <a:t> tags, so a tag-content regex is sufficient and avoids a dependency.
 */
export async function extractPptxText(JSZip, fileBlob) {
  const zip = await JSZip.loadAsync(fileBlob);
  const slideNames = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(naturalSlideSort);

  const slideTexts = [];
  for (const name of slideNames) {
    const xml = await zip.files[name].async('string');
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => decodeHtmlEntities(m[1]));
    const slideText = runs.join(' ').replace(/\s+/g, ' ').trim();
    if (slideText) slideTexts.push(slideText);
  }
  return slideTexts.join('\n');
}

/**
 * Applies the per-file character budget, returning both the (possibly
 * truncated) text and whether truncation happened — callers must surface
 * that to the user, never truncate silently.
 */
export function capDocText(text) {
  const trimmed = (text || '').trim();
  if (trimmed.length <= MAX_CHARS_PER_DOC) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, MAX_CHARS_PER_DOC), truncated: true };
}

/**
 * Assembles the prompt-ready reference-docs block under the total budget
 * (MAX_TOTAL_REFERENCE_CHARS across all docs combined), labeling each
 * excerpt with its source filename per-doc so the model can distinguish
 * reference material from the current log's own observations, and reports
 * what got left out instead of silently dropping it.
 */
export function buildReferenceDocsBlock(docs) {
  if (!docs || !docs.length) return { text: '', truncation: { excludedDocs: 0, textTruncatedChars: 0 } };

  let budget = MAX_TOTAL_REFERENCE_CHARS;
  const included = [];
  let excludedDocs = 0;
  let textTruncatedChars = 0;

  for (const doc of docs) {
    if (budget <= 0) { excludedDocs++; continue; }
    const block = `[참고 파일: ${doc.name}]\n${doc.text}`;
    if (block.length <= budget) {
      included.push(block);
      budget -= block.length;
    } else {
      included.push(block.slice(0, budget) + '\n...(문자 수 제한으로 이하 생략)');
      textTruncatedChars += block.length - budget;
      budget = 0;
    }
  }

  return {
    text: included.join('\n\n'),
    truncation: { excludedDocs, textTruncatedChars }
  };
}
