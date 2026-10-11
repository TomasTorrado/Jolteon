// Export tab: fetching, metrics and CSV building.
//
// Pure functions plus thin fetch wrappers, no React, so the numbers can be
// checked outside the browser (scripts/check_export_metrics.mjs does exactly
// that). Dashboard.jsx stays a view.

const BASE = import.meta.env?.VITE_API_URL ?? '';

// The export must reflect the recorder as of the moment it is clicked, so these
// requests never come from cache. api.js is left alone -- its polling wrappers
// are shared with the live cards and should keep their default behaviour.
async function getFresh(path, params, signal) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(`${BASE}/api${path}${qs}`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`GET /api${path} failed (${res.status})`);
  return res.json();
}

// Big enough to defeat the server-side downsampler in api/main.py, which keeps
// every Nth row and so aliases peaks (a 24 h window has reported a LOWER peak
// than the 12 h window inside it). Peak power must come from raw rows.
const MAX_POINTS = 100000;

export const RANGES = [
  { key: 'all', label: 'Whole run' },
  { key: '12h', label: '12h', hours: 12 },
  { key: '24h', label: '24h', hours: 24 },
];

// The reading object as the API returns it (api/sources.py FIELDS, which is
// bridge/local_db.py COLUMNS minus uptime_s). Verified 2026-10-11.
export const FIELDS = [
  'ts', 'seq', 'phase', 't_hot_c', 't_cold_c', 'delta_t_c',
  'gen_v', 'gen_ma', 'gen_w', 'batt_v', 'batt_ma', 'batt_w',
  'charge_mah', 'energy_wh',
];

/** Fetch health + summary + the rows for one range. Never falls back to sample data. */
export async function fetchExport(rangeKey, signal) {
  const [health, summary] = await Promise.all([
    getFresh('/health', null, signal),
    getFresh('/summary', null, signal),
  ]);

  const fetchedAt = Date.now();
  // Empty table: /api/summary returns all nulls/zeros and /api/readings would be [].
  if (!summary || !summary.latest_ts) {
    return { health, summary, rows: [], fetchedAt, since: null };
  }

  // Windows are measured back from the LATEST ROW, not the browser clock, so a
  // paused recorder still yields the last 12/24 h of real data.
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[0];
  const since = range.hours
    ? new Date(Date.parse(summary.latest_ts) - range.hours * 3600e3).toISOString()
    : null;

  const params = { max_points: String(MAX_POINTS) };
  if (since) params.since = since; // omitted for "Whole run" -- `since` is exclusive
  const rows = await getFresh('/readings', params, signal);

  return { health, summary, rows: Array.isArray(rows) ? rows : [], fetchedAt, since };
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

// A serial RESET zeroes seq AND both cumulative counters together (the
// firmware's resetState()), so a DECREASING seq is the reliable signature.
//
// Treating *any* backwards step in a counter as a reset does not work: on the
// live 7.4 h run energy_wh dips 20 times -- by as little as 0.00001 Wh, during
// ordinary discharge -- while seq never decreases once. That rule splits one
// continuous run into 111 segments and inflates the total by ~0.011 Wh, which
// would also disagree with the "Gained" row on the Energy stored card.
//
// The counter test is kept as a defensive guard, but only fires on a collapse
// toward zero, which is what a reset actually looks like.
const isReset = (a, b) =>
  b.seq < a.seq ||
  (a.energy_wh > 0.01 && b.energy_wh < a.energy_wh * 0.1) ||
  (a.charge_mah > 1 && b.charge_mah < a.charge_mah * 0.1);

/** Split rows (already sorted by ts) into runs separated by counter resets. */
export function segments(rows) {
  if (!rows.length) return [];
  const out = [[rows[0]]];
  for (let i = 1; i < rows.length; i++) {
    if (isReset(rows[i - 1], rows[i])) out.push([rows[i]]);
    else out[out.length - 1].push(rows[i]);
  }
  return out;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Everything the preview card and the printed report need.
 * `rows` may be unsorted; nulls in the temperature fields are skipped, never
 * coerced to 0. Out-of-range values are reported as they are.
 */
export function metrics(rows, phoneWh) {
  const sorted = [...(rows || [])].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const n = sorted.length;
  if (!n) return { count: 0, empty: true };

  const first = sorted[0];
  const last = sorted[n - 1];
  const segs = segments(sorted);

  // Cumulative counters: sum the per-segment deltas. NEVER sum raw values.
  const energyGained = segs.reduce((s, g) => s + (g[g.length - 1].energy_wh - g[0].energy_wh), 0);
  const chargeGained = segs.reduce((s, g) => s + (g[g.length - 1].charge_mah - g[0].charge_mah), 0);

  const spanMs = Date.parse(last.ts) - Date.parse(first.ts);
  const hours = spanMs / 3600e3;
  const avgPowerW = hours > 0 ? energyGained / hours : NaN;

  // gen_w is rounded to 3 dp by bridge.py, so recompute the peak from the raw
  // voltage and current -- otherwise anything under 0.5 mW reads as exactly 0.
  let peakW = -Infinity;
  let peakRow = null;
  for (const r of sorted) {
    const w = finite(r.gen_v) && finite(r.gen_ma) ? (r.gen_v * r.gen_ma) / 1000 : NaN;
    if (finite(w) && w > peakW) { peakW = w; peakRow = r; }
  }
  if (!peakRow) peakW = NaN;

  const battVals = sorted.map((r) => r.batt_v).filter(finite);
  const dtVals = sorted.map((r) => r.delta_t_c).filter(finite);
  const hotVals = sorted.map((r) => r.t_hot_c).filter(finite);

  // Row count per phase, and the time each phase covers (each row stands for the
  // gap since the previous one). `phase` is an open string: whatever the
  // firmware sends is counted, not just charging/discharging.
  const phases = new Map();
  for (let i = 0; i < n; i++) {
    const key = sorted[i].phase == null ? 'unknown' : String(sorted[i].phase);
    const prev = phases.get(key) || { phase: key, rows: 0, ms: 0 };
    prev.rows += 1;
    if (i > 0) prev.ms += Date.parse(sorted[i].ts) - Date.parse(sorted[i - 1].ts);
    phases.set(key, prev);
  }

  const pct = phoneWh > 0 ? Math.max(0, (energyGained / phoneWh) * 100) : NaN;

  return {
    empty: false,
    count: n,
    rows: sorted,
    segments: segs.length,
    resets: segs.length - 1,
    firstTs: first.ts,
    lastTs: last.ts,
    spanMs,
    hours,
    energyGained,
    chargeGained,
    storedNow: last.energy_wh,
    chargeNow: last.charge_mah,
    avgPowerW,
    peakW,
    peakTs: peakRow ? peakRow.ts : null,
    battStart: battVals.length ? battVals[0] : NaN,
    battEnd: battVals.length ? battVals[battVals.length - 1] : NaN,
    battChange: battVals.length > 1 ? battVals[battVals.length - 1] - battVals[0] : NaN,
    battMin: battVals.length ? Math.min(...battVals) : NaN,
    battMax: battVals.length ? Math.max(...battVals) : NaN,
    maxDt: dtVals.length ? Math.max(...dtVals) : NaN,
    meanDt: dtVals.length ? dtVals.reduce((a, b) => a + b, 0) / dtVals.length : NaN,
    peakHot: hotVals.length ? Math.max(...hotVals) : NaN,
    missingTemps: n - dtVals.length,
    phonePct: pct,
    phases: [...phases.values()].sort((a, b) => b.rows - a.rows),
  };
}

// ---------------------------------------------------------------------------
// Formatting + CSV
// ---------------------------------------------------------------------------

const pad = (v) => String(v).padStart(2, '0');

/** "2026-10-11 01:42:10 AM" in the viewer's local zone. */
export function localTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h24 = d.getHours();
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 || 12;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`;
}

export function fileStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// RFC 4180: quote only when needed, double any embedded quote. null -> empty cell.
const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * A pure data table: BOM, then the header row, then one row per reading.
 * No comments, no metadata, no preamble -- traceability lives in the PDF.
 */
export function buildCsv(rows) {
  const header = ['ts', 'local_time', ...FIELDS.slice(1)];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      cell(r.ts),
      cell(localTime(r.ts)),
      ...FIELDS.slice(1).map((f) => cell(r[f])),
    ].join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function downloadCsv(rows, filename) {
  const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
