import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { makeAccumulator, feedLine, applyAccumulatorToSource } from '../src/log-engine.js';
import { LFP_CELL_ARRAY_FORMAT } from '../src/formats.js';
import { figureCatalog, buildFigures } from '../src/figures.js';
import { blocksToPromptText } from '../src/pipeline.js';

const csvPath = path.resolve('Log_sample/extracted/data_sys_6_stride80.csv');
if (!existsSync(csvPath)) {
  console.error('missing', csvPath);
  process.exit(1);
}

const acc = makeAccumulator(LFP_CELL_ARRAY_FORMAT);
const rl = createInterface({ input: createReadStream(csvPath) });
for await (const line of rl) {
  if (line.trim()) feedLine(acc, line);
}
const src = { name: 'data_sys_6_stride80.csv' };
applyAccumulatorToSource(src, acc);

const years = [...new Set((src.alarmSampleTimes || [])
  .filter(Number.isFinite)
  .map(t => new Date(t).getUTCFullYear()))].sort((a, b) => a - b);

const buckets = (src.derived?.categoryTimeBuckets || []).map(b => {
  const oc = b.counts?.outlierCell || {};
  const ranked = Object.entries(oc).sort((a, c) => c[1] - a[1]);
  return {
    start: (b.start || '').slice(0, 10),
    end: (b.end || '').slice(0, 10),
    top: ranked[0] ? ranked[0][0] : null,
    topCount: ranked[0] ? ranked[0][1] : 0,
    outlierCell: oc
  };
});

const block = {
  label: 'data_sys_6_stride80.csv',
  columns: src.columns,
  delimiter: src.delimiter || ',',
  rowCount: src.rowCount,
  alarmCount: src.alarmCount,
  headSample: src.headSample || [],
  alarmSamples: src.alarmSamples || [],
  alarmAnnotations: src.alarmAnnotations || [],
  stats: src.stats || {},
  groups: null,
  formatId: 'lfp-cell-array',
  formatLabel: 'LFP cell-array 필드 데이터',
  entityColumn: null,
  derived: src.derived,
  seriesByEntity: src.seriesByEntity || {},
  resistanceEventsByEntity: src.resistanceEventsByEntity || {},
  droppedResistanceEvents: src.droppedResistanceEvents || 0,
  dataTimeRange: src.dataTimeRange,
  evidenceTimeRange: src.evidenceTimeRange,
  timeCoverageRatio: src.timeCoverageRatio,
  alarmDroppedCount: src.alarmDroppedCount,
  alarmSampleTimeDistribution: src.alarmSampleTimeDistribution
};

const { text, truncation, sourceProfiles } = blocksToPromptText([block]);
const figures = buildFigures([block]);
const catalog = figureCatalog(figures);

const report = {
  rowCount: src.rowCount,
  alarmCount: src.alarmCount,
  derivedAlarmCount: src.derived?.alarmCount,
  dataTimeRange: src.dataTimeRange,
  evidenceTimeRange: src.evidenceTimeRange,
  timeCoverageRatio: src.timeCoverageRatio,
  alarmDroppedCount: src.alarmDroppedCount,
  keptAlarmSamples: (src.alarmSamples || []).length,
  keptAlarmYears: years,
  alarmSampleTimeDistribution: src.alarmSampleTimeDistribution,
  wholeLogOutlierCell: src.derived?.categoryCounts?.outlierCell,
  outlierCellByTime: buckets,
  lowTimeCoverage: truncation.lowTimeCoverage,
  promptHasDataRange: text.includes('데이터 시간 범위'),
  promptHasEvidenceRange: text.includes('알람 근거 시간 범위'),
  promptHasCoverageNote: /알람 근거 시간 범위가 데이터 전체 구간의 일부만 덮습니다/.test(text),
  promptHasOutlierTime: text.includes('파생 범주 시간 분포'),
  sourceProfiles,
  figureTimeRanges: catalog.map(f => ({ id: f.id, available: f.available, timeRange: f.timeRange }))
};

const outPath = path.resolve('Report/analysis-horizons-stride80.json');
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('wrote', outPath);
