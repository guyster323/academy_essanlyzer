import test from 'node:test';
import assert from 'node:assert/strict';
import { yDomain, xDomain, layoutChart, CHART_PALETTE } from '../../src/charts.js';

test('yDomain pads a non-empty series and survives identical values', () => {
  const d = yDomain([{ y: [1, 2, 3], t: [0, 1, 2] }]);
  assert.ok(d.min < 1 && d.max > 3);
  const flat = yDomain([{ y: [5, 5], t: [0, 1] }]);
  assert.ok(flat.min < 5 && flat.max > 5);
});

test('layoutChart maps domain edges onto the inner plot box', () => {
  const spec = { series: [{ t: [100, 200], y: [0, 10], name: 'a', color: CHART_PALETTE[0] }] };
  const L = layoutChart(spec, 1200, 480);
  assert.ok(Math.abs(L.xAt(100) - L.margin.l) < 0.5);
  assert.ok(Math.abs(L.xAt(200) - (L.margin.l + L.innerW)) < 0.5);
  const xd = xDomain(spec.series);
  assert.equal(xd.min, 100);
  assert.equal(xd.max, 200);
});
