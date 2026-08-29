import { chartToPng } from './charts.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function buildReportHtml({ report = {}, figures = [], comparison = null, severity = '', severityReason = '', hypothesis = {}, createdAt = '' }) {
  const img = (fig) => {
    if (!fig.available) {
      return `<p class="missing">${esc(fig.unavailableReason || '그래프 없음')}</p>`;
    }
    const png = typeof document !== 'undefined' ? chartToPng(fig) : '';
    if (!png) return `<p class="missing">${esc(fig.claim)}</p>`;
    return `<img alt="${esc(fig.id)}" src="${png}" style="max-width:100%;height:auto;border:1px solid #ddd"/>`;
  };

  const figureBlocks = (figures || []).map(fig => `
    <section class="fig">
      <h3>${esc(fig.id)}</h3>
      <p><strong>${esc(fig.claim)}</strong></p>
      ${img(fig)}
    </section>`).join('');

  const findings = (report.independentFindings || []).map(f => `<li>${esc(f)}</li>`).join('');
  const implications = (report.managementImplications || []).map(f => `<li>${esc(f)}</li>`).join('');
  const fta = (report.ftaLeaves || []).map(l => `<tr><td>${esc(l.branch)}</td><td>${esc(l.disposition)}</td><td>${esc((l.evidenceIds || []).join(', '))}</td></tr>`).join('');
  const cmp = (comparison || []).map(r => `<tr>
    <td>${esc(r.item)}</td><td>${esc(r.independentFinding)}</td><td>${esc(r.publishedFinding)}</td>
    <td>${esc(r.agree)}</td><td>${r.rawSufficient ? 'yes' : 'no'}</td><td>${esc(r.notes)}</td>
  </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>${esc(report.headline || 'ESS 분석 보고서')}</title>
<style>
  body{font-family:'Malgun Gothic',sans-serif;color:#1a1a1a;max-width:900px;margin:24px auto;padding:0 16px;line-height:1.6;}
  h1{font-size:20px;} h2{font-size:15px;border-bottom:1px solid #ddd;padding-bottom:4px;}
  .box{border:1px solid #ccc;padding:10px 12px;margin:8px 0;}
  table{border-collapse:collapse;width:100%;font-size:13px;}
  td,th{border:1px solid #ddd;padding:6px 8px;vertical-align:top;}
  @media print { .noprint{display:none} body{margin:0} }
</style></head><body>
  <p class="noprint">인쇄하여 PDF로 저장할 수 있습니다. 시계열은 이 세션에서 생성된 그림입니다.</p>
  <h1>${esc(report.headline || '')}</h1>
  <p>생성: ${esc(createdAt)} · 확정 가설: ${esc(hypothesis.name || '')} · 심각도 ${esc(severity)} (${esc(severityReason)})</p>
  <h2>What Happened</h2>
  <p>${esc(report.occurrence || '')}</p>
  ${figureBlocks}
  <h2>Why We Think So</h2>
  <p>${esc(report.rootCause || '')}</p>
  <p>${esc(report.anomalySummary || '')}</p>
  <h2>FTA</h2>
  <table><thead><tr><th>Branch</th><th>Disposition</th><th>Evidence</th></tr></thead><tbody>${fta}</tbody></table>
  <h2>Independent Findings</h2>
  <ol>${findings}</ol>
  <div class="box"><strong>데이터가 입증하는 것</strong><p>${esc(report.provenBox || '')}</p></div>
  <div class="box"><strong>데이터가 강하게 시사하는 것</strong><p>${esc(report.suggestedBox || '')}</p></div>
  <div class="box"><strong>데이터가 판단할 수 없는 것</strong><p>${esc(report.unknownBox || '')}</p></div>
  <h2>조치</h2>
  <p>${esc(report.actionRecommendation || '')}</p>
  <ul>${implications}</ul>
  ${cmp ? `<h2>공개 결과 대조</h2>
    <table><thead><tr><th>항목</th><th>독립분석</th><th>공개결과</th><th>일치</th><th>RAW 충분</th><th>비고</th></tr></thead>
    <tbody>${cmp}</tbody></table>` : ''}
</body></html>`;
}
