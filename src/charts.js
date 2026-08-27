import { FIGURE_PNG_MAX_PX } from './series-engine.js';

export const CHART_PALETTE = ['#FFAB2E', '#3ED6D0', '#FF5A5F', '#33D17E', '#C084FC', '#60A5FA', '#F472B6', '#FBBF24'];

export function yDomain(series) {
  let min = Infinity;
  let max = -Infinity;
  (series || []).forEach(s => {
    (s.y || []).forEach(v => {
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
    (s.lo || []).forEach(v => { if (Number.isFinite(v) && v < min) min = v; });
    (s.hi || []).forEach(v => { if (Number.isFinite(v) && v > max) max = v; });
  });
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

export function xDomain(series) {
  let min = Infinity;
  let max = -Infinity;
  (series || []).forEach(s => {
    (s.t || []).forEach(v => {
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
  });
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1000, max: max + 1000 };
  return { min, max };
}

function formatTick(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const spanHint = d;
  return `${spanHint.getMonth() + 1}/${spanHint.getDate()} ${String(spanHint.getHours()).padStart(2, '0')}:${String(spanHint.getMinutes()).padStart(2, '0')}`;
}

export function layoutChart(spec, width, height) {
  const margin = { l: 56, r: 14, t: 10, b: 38 };
  const series = spec.series || [];
  const xd = xDomain(series);
  const yd = yDomain(series);
  const innerW = Math.max(1, width - margin.l - margin.r);
  const innerH = Math.max(1, height - margin.t - margin.b);
  const xAt = (t) => margin.l + ((t - xd.min) / (xd.max - xd.min || 1)) * innerW;
  const yAt = (v) => margin.t + (1 - (v - yd.min) / (yd.max - yd.min || 1)) * innerH;
  return { margin, xd, yd, innerW, innerH, xAt, yAt, width, height };
}

export function drawLineChart(ctx, spec, width, height) {
  const L = layoutChart(spec, width, height);
  ctx.fillStyle = '#0D1013';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#242A32';
  ctx.lineWidth = 1;
  ctx.strokeRect(L.margin.l, L.margin.t, L.innerW, L.innerH);

  ctx.fillStyle = '#576270';
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = L.yd.min + (L.yd.max - L.yd.min) * (i / 4);
    const y = L.yAt(v);
    ctx.strokeStyle = '#1B2027';
    ctx.beginPath();
    ctx.moveTo(L.margin.l, y);
    ctx.lineTo(L.margin.l + L.innerW, y);
    ctx.stroke();
    ctx.fillStyle = '#576270';
    ctx.fillText(v.toFixed(Math.abs(v) >= 100 ? 0 : 2), L.margin.l - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(formatTick(L.xd.min), L.margin.l, height - 26);
  ctx.fillText(formatTick(L.xd.max), L.margin.l + L.innerW, height - 26);
  if (spec.yLabel) {
    ctx.save();
    ctx.translate(12, L.margin.t + L.innerH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(spec.yLabel, 0, 0);
    ctx.restore();
  }

  (spec.series || []).forEach((s, idx) => {
    const color = s.color || CHART_PALETTE[idx % CHART_PALETTE.length];
    if (s.lo && s.hi && s.lo.length === s.t.length) {
      ctx.fillStyle = color + '22';
      ctx.beginPath();
      s.t.forEach((t, i) => {
        const x = L.xAt(t);
        const y = L.yAt(s.hi[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      for (let i = s.t.length - 1; i >= 0; i--) ctx.lineTo(L.xAt(s.t[i]), L.yAt(s.lo[i]));
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    (s.t || []).forEach((t, i) => {
      const v = s.y[i];
      if (!Number.isFinite(t) || !Number.isFinite(v)) return;
      const x = L.xAt(t);
      const y = L.yAt(v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  (spec.markers || []).forEach(m => {
    if (!Number.isFinite(m.t)) return;
    const x = L.xAt(m.t);
    ctx.strokeStyle = '#FF5A5F';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, L.margin.t);
    ctx.lineTo(x, L.margin.t + L.innerH);
    ctx.stroke();
    ctx.setLineDash([]);
    if (m.label) {
      ctx.fillStyle = '#FF5A5F';
      ctx.textAlign = 'left';
      ctx.fillText(m.label, x + 4, L.margin.t + 8);
    }
  });
}

export function paintFigureCanvases(figures, root) {
  if (typeof document === 'undefined') return;
  const host = root || document;
  (figures || []).forEach(fig => {
    if (!fig.available) return;
    const canvas = host.querySelector(`canvas[data-figure-id="${fig.id}"]`);
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = FIGURE_PNG_MAX_PX.width;
    const h = FIGURE_PNG_MAX_PX.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = '100%';
    canvas.style.maxWidth = `${w}px`;
    canvas.style.height = 'auto';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLineChart(ctx, fig, w, h);
  });
}

export function chartToPng(fig) {
  if (typeof document === 'undefined' || !fig?.available) return '';
  const canvas = document.createElement('canvas');
  const w = FIGURE_PNG_MAX_PX.width;
  const h = FIGURE_PNG_MAX_PX.height;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  drawLineChart(ctx, fig, w, h);
  try {
    return canvas.toDataURL('image/png');
  } catch (e) {
    return '';
  }
}
