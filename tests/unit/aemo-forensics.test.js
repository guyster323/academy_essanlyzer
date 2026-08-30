import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { frozenFromPairs } from '../../src/series-engine.js';
import { classifyCommonMode } from '../../src/forensics/aemo.js';
import { buildFigures } from '../../src/figures.js';

const fixture = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/case-a-common-mode.json'),
  'utf8'
));

function buildPairs(dropEntities, spec) {
  const t0 = Date.UTC(2025, 7, 19, 11, 0, 0);
  const out = {};
  const entities = spec.entities || [spec.focus, ...(spec.peers || [])].filter(Boolean);
  entities.forEach(id => {
    const pairs = [];
    for (let i = 0; i < fixture.length; i++) {
      const dropping = i >= fixture.dropAtIndex && dropEntities.includes(id);
      pairs.push([t0 + i * fixture.dtMs, dropping ? fixture.baseline - fixture.drop : fixture.baseline]);
    }
    out[id] = frozenFromPairs(id, pairs, 'mw');
  });
  return out;
}

test('A-F4 classifies synchronized MW drops as common-mode', () => {
  const series = buildPairs(fixture.commonMode.entities, fixture.commonMode);
  const result = classifyCommonMode('WDBESS1', series);
  assert.equal(result.mode, 'common-mode');
  assert.ok(result.supportingCount >= 1);
  const figures = buildFigures([{ formatId: 'aemo-mms', seriesByEntity: series, resistanceEventsByEntity: {} }]);
  const af4 = figures.find(f => f.id === 'A-F4');
  assert.equal(af4.summaryStats.mode, 'common-mode');
  assert.match(af4.claim, /동조/);
  assert.equal(af4.available, true);
  assert.equal(af4.unavailableReason, null);
});

test('A-F4 classifies a lone MW drop as local', () => {
  const series = buildPairs([fixture.localOnly.focus], fixture.localOnly);
  const result = classifyCommonMode('WDBESS1', series);
  assert.equal(result.mode, 'local');
  const figures = buildFigures([{ formatId: 'aemo-mms', seriesByEntity: series, resistanceEventsByEntity: {} }]);
  const af4 = figures.find(f => f.id === 'A-F4');
  assert.equal(af4.summaryStats.mode, 'local');
  assert.match(af4.claim, /설비만|단독|Local/i);
});
