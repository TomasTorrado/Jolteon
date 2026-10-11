// Checks for web/src/dashboard/exportData.js. Pure functions, so they run in
// node with no browser and no database.
//
//   node scripts/check_export_metrics.mjs              # unit checks only
//   node scripts/check_export_metrics.mjs --live       # also cross-check the API
//
// --live is READ-ONLY: it issues GETs against http://127.0.0.1:8000 and writes
// nothing anywhere.

import { buildCsv, localTime, metrics, segments } from '../web/src/dashboard/exportData.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Proper RFC 4180 reader, so the check tests the CSV and not a toy regex.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c !== '"') cur += c;
      else if (line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// One row, with sensible defaults so each case states only what it cares about.
const row = (o) => ({
  ts: o.ts, seq: o.seq, phase: o.phase ?? 'charging',
  t_hot_c: 't_hot_c' in o ? o.t_hot_c : 50, t_cold_c: 't_cold_c' in o ? o.t_cold_c : 10,
  delta_t_c: 'delta_t_c' in o ? o.delta_t_c : 40,
  gen_v: o.gen_v ?? 3, gen_ma: o.gen_ma ?? 100, gen_w: o.gen_w ?? 0.3,
  batt_v: o.batt_v ?? 2.5, batt_ma: o.batt_ma ?? 100, batt_w: o.batt_w ?? 0.25,
  charge_mah: o.charge_mah ?? 0, energy_wh: o.energy_wh ?? 0,
});
const T = (min) => new Date(Date.UTC(2026, 9, 11, 0, min, 0)).toISOString();

console.log('\n1. simple run, no reset');
{
  const rows = [
    row({ ts: T(0),  seq: 1, energy_wh: 0.10, charge_mah: 10, batt_v: 2.40 }),
    row({ ts: T(30), seq: 2, energy_wh: 0.40, charge_mah: 50, batt_v: 2.55 }),
    row({ ts: T(60), seq: 3, energy_wh: 1.10, charge_mah: 90, batt_v: 2.70 }),
  ];
  const m = metrics(rows, 13.9);
  ok(m.segments === 1, 'one segment');
  ok(close(m.energyGained, 1.0), 'energy gained = 1.10 - 0.10', `got ${m.energyGained}`);
  ok(close(m.chargeGained, 80), 'charge gained = 80 mAh', `got ${m.chargeGained}`);
  ok(close(m.hours, 1), 'span = 1 h');
  ok(close(m.avgPowerW, 1.0), 'avg power = 1.0 W/h', `got ${m.avgPowerW}`);
  ok(close(m.battChange, 0.3, 1e-9), 'batt change = +0.30 V', `got ${m.battChange}`);
  ok(close(m.phonePct, (1.0 / 13.9) * 100), 'phone % from energy gained');
}

console.log('\n2. small backwards dips are NOT resets (real discharge)');
{
  // Mirrors live data: energy_wh dips a few uWh while seq keeps climbing.
  const rows = [
    row({ ts: T(0),  seq: 1, energy_wh: 0.05154 }),
    row({ ts: T(10), seq: 2, energy_wh: 0.04422 }), // dip
    row({ ts: T(20), seq: 3, energy_wh: 0.08000 }),
  ];
  const m = metrics(rows, 13.9);
  ok(m.segments === 1, 'still one segment', `got ${m.segments}`);
  ok(close(m.energyGained, 0.08 - 0.05154), 'gain is the plain delta', `got ${m.energyGained}`);
}

console.log('\n3. a real RESET (seq drops, counters zero)');
{
  const rows = [
    row({ ts: T(0),  seq: 10, energy_wh: 0.50, charge_mah: 100 }),
    row({ ts: T(10), seq: 11, energy_wh: 0.90, charge_mah: 180 }),
    row({ ts: T(20), seq: 0,  energy_wh: 0.00, charge_mah: 0 }),   // RESET
    row({ ts: T(30), seq: 1,  energy_wh: 0.25, charge_mah: 40 }),
  ];
  const m = metrics(rows, 13.9);
  ok(m.segments === 2, 'two segments', `got ${m.segments}`);
  ok(m.resets === 1, 'one reset reported');
  // 0.40 before the reset + 0.25 after = 0.65, NOT 0.25 - 0.50 = -0.25
  ok(close(m.energyGained, 0.65), 'per-segment sum = 0.65 Wh', `got ${m.energyGained}`);
  ok(close(m.chargeGained, 120), 'charge = 80 + 40 mAh', `got ${m.chargeGained}`);
}

console.log('\n4. null temperatures are skipped, never zeroed');
{
  const rows = [
    row({ ts: T(0),  seq: 1, t_hot_c: null, t_cold_c: null, delta_t_c: null }),
    row({ ts: T(10), seq: 2, t_hot_c: 80, t_cold_c: 10, delta_t_c: 70 }),
    row({ ts: T(20), seq: 3, t_hot_c: 60, t_cold_c: 10, delta_t_c: 50 }),
  ];
  const m = metrics(rows, 13.9);
  ok(close(m.meanDt, 60), 'mean dT over the 2 real rows = 60, not 40', `got ${m.meanDt}`);
  ok(close(m.maxDt, 70), 'max dT = 70');
  ok(close(m.peakHot, 80), 'peak hot = 80');
  ok(m.missingTemps === 1, 'one missing reading counted');
}

console.log('\n5. peak power is recomputed, not read from the 3dp gen_w');
{
  const rows = [
    row({ ts: T(0),  seq: 1, gen_v: 0.4, gen_ma: 0.6, gen_w: 0.000 }), // 0.24 mW -> stored as 0.000
    row({ ts: T(10), seq: 2, gen_v: 0.3, gen_ma: 0.5, gen_w: 0.000 }),
  ];
  const m = metrics(rows, 13.9);
  ok(close(m.peakW, 0.00024), 'peak = 0.24 mW from gen_v x gen_ma', `got ${m.peakW}`);
  ok(m.peakTs === T(0), 'peak timestamp reported');
}

console.log('\n6. unsorted input, open phase strings, empty');
{
  const rows = [
    row({ ts: T(20), seq: 3, phase: 'Idle', energy_wh: 0.3 }),
    row({ ts: T(0),  seq: 1, phase: 'charging', energy_wh: 0.1 }),
    row({ ts: T(10), seq: 2, phase: 'weird-code', energy_wh: 0.2 }),
  ];
  const m = metrics(rows, 13.9);
  ok(m.firstTs === T(0) && m.lastTs === T(20), 'sorted by ts, not input order');
  ok(close(m.energyGained, 0.2), 'gain uses time order', `got ${m.energyGained}`);
  ok(m.phases.length === 3, 'three distinct phase values kept', m.phases.map((p) => p.phase).join('/'));
  ok(metrics([], 13.9).empty === true, 'empty input -> empty:true');
  ok(segments([]).length === 0, 'segments([]) is []');
}

console.log('\n7. short run under a minute');
{
  const rows = [
    row({ ts: '2026-10-11T00:00:00.000Z', seq: 1, energy_wh: 0.00 }),
    row({ ts: '2026-10-11T00:00:30.000Z', seq: 2, energy_wh: 0.01 }),
  ];
  const m = metrics(rows, 13.9);
  ok(close(m.energyGained, 0.01), 'gain still computed');
  ok(Number.isFinite(m.avgPowerW) && m.avgPowerW > 0, 'avg power finite (span > 0)', `got ${m.avgPowerW}`);
}

console.log('\n8. CSV shape');
{
  const rows = [
    row({ ts: '2026-10-11T05:42:10.195207+00:00', seq: 7, t_hot_c: null, delta_t_c: null, phase: 'a,b"c' }),
  ];
  const csv = buildCsv(rows);
  ok(csv.charCodeAt(0) === 0xfeff, 'starts with a UTF-8 BOM');
  const lines = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  ok(lines[0] === 'ts,local_time,seq,phase,t_hot_c,t_cold_c,delta_t_c,gen_v,gen_ma,gen_w,batt_v,batt_ma,batt_w,charge_mah,energy_wh',
     'line 1 is the header, local_time right after ts');
  ok(lines.length === 2, 'no comment or metadata lines', `${lines.length} lines`);
  const cells = parseCsvLine(lines[1]);
  ok(cells.length === 15, '15 columns', `got ${cells.length}`);
  ok(cells[0] === '2026-10-11T05:42:10.195207+00:00', 'ts kept as the raw UTC string');
  ok(cells[4] === '' && cells[6] === '', 'nulls are empty cells, not "null"');
  ok(cells[3] === 'a,b"c', 'RFC 4180 escaping round-trips', JSON.stringify(cells[3]));
  ok(localTime('2026-10-11T05:42:10.195207+00:00').match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (AM|PM)$/) !== null,
     'local_time format', localTime('2026-10-11T05:42:10.195207+00:00'));
}

if (process.argv.includes('--live')) {
  console.log('\n9. live cross-check against the running API (read-only)');
  const base = 'http://127.0.0.1:8000';
  const j = async (p) => (await fetch(base + p, { cache: 'no-store' })).json();
  try {
    const health = await j('/api/health');
    const summary = await j('/api/summary');
    const rows = await j('/api/readings?max_points=100000');
    const m = metrics(rows, 13.9);
    console.log(`  source=${health.source}  summary.count=${summary.count}  rows=${rows.length}`);
    ok(health.source === 'supabase', 'API is serving Supabase');
    ok(m.count === summary.count, 'row count matches /api/summary count', `${m.count} vs ${summary.count}`);
    ok(close(m.storedNow, summary.energy_wh, 1e-9), 'stored total matches summary.energy_wh',
       `${m.storedNow} vs ${summary.energy_wh}`);
    const cardGained = rows[rows.length - 1].energy_wh - rows[0].energy_wh;
    ok(close(m.energyGained, cardGained, 1e-9),
       'energy gained matches the Energy card formula (last - first)',
       `${m.energyGained.toFixed(5)} vs ${cardGained.toFixed(5)}`);
    console.log(`  segments=${m.segments} resets=${m.resets} peak=${m.peakW.toFixed(5)} W` +
                `  avg=${m.avgPowerW.toFixed(4)} W  span=${m.hours.toFixed(2)} h`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  live check could not run: ${e.message}`);
  }
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
