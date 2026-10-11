import { useCallback, useEffect, useRef, useState } from 'react';
import {
  downloadCsv,
  fetchExport,
  fileStamp,
  localTime,
  metrics,
  RANGES,
} from './exportData';
import './export.css';

const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const signed = (v, d) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '—');
const span = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / 3600e3);
  const m = Math.round((ms % 3600e3) / 60e3);
  return h ? `${h} h ${m} min` : `${m} min`;
};

// Static SVG for paper: no hover, no live state, no dark well. Chart.jsx is
// built for the screen (dark background, pointer handlers, auto-zoom tuned for
// a live tail), so the print sheet draws its own.
const PW = 760;
const PH = 150;
const PAD_T = 10;
const PAD_B = 18;

function PrintChart({ rows, lines, unit }) {
  const pts = rows.length > 600 ? rows.filter((_, i) => i % Math.ceil(rows.length / 600) === 0) : rows;
  const t = pts.map((r) => Date.parse(r.ts));
  const cols = lines.map((l) => pts.map((r) => l.value(r)));
  const all = cols.flat().filter((v) => Number.isFinite(v));
  if (pts.length < 2 || !all.length) return <div className="jl-pr-nochart">Not enough data to plot.</div>;

  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-9) { const p = Math.abs(hi) * 0.05 || 1; lo -= p; hi += p; }
  const padv = (hi - lo) * 0.08;
  lo -= padv; hi += padv;

  const t0 = t[0];
  const t1 = t[t.length - 1];
  const X = (ms) => ((ms - t0) / (t1 - t0 || 1)) * PW;
  const Y = (v) => PAD_T + (1 - (v - lo) / (hi - lo)) * (PH - PAD_T - PAD_B);

  return (
    <div className="jl-pr-chart">
      <svg viewBox={`0 0 ${PW} ${PH}`} preserveAspectRatio="none" role="img">
        <line x1="0" y1={PH - PAD_B} x2={PW} y2={PH - PAD_B} className="jl-pr-axis" />
        {cols.map((vals, k) => {
          let d = '';
          let open = false;
          vals.forEach((v, i) => {
            if (!Number.isFinite(v)) { open = false; return; }
            d += `${open ? 'L' : 'M'}${X(t[i]).toFixed(1)} ${Y(v).toFixed(1)} `;
            open = true;
          });
          return <path key={k} d={d.trim()} fill="none" stroke={lines[k].color} strokeWidth="1.8"
                       strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <div className="jl-pr-scale">
        <span>{num(lo, 2)} {unit}</span>
        <span className="jl-pr-keys">
          {lines.map((l) => (
            <span key={l.label}><i style={{ background: l.color }} />{l.label}</span>
          ))}
        </span>
        <span>{num(hi, 2)} {unit}</span>
      </div>
      <div className="jl-pr-xaxis">
        <span>{localTime(pts[0].ts)}</span>
        <span>{localTime(pts[pts.length - 1].ts)}</span>
      </div>
    </div>
  );
}

export default function Export({ Card, Rows, Segmented, phoneWh }) {
  const [range, setRange] = useState('all');
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [busy, setBusy] = useState(null); // 'csv' | 'print' | null
  const ctrl = useRef(null);

  // Always re-reads the recorder. Returns the payload so the CSV and the print
  // sheet can be built from the data as of the click, not as of the last poll.
  const load = useCallback(async (key) => {
    if (ctrl.current) ctrl.current.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const data = await fetchExport(key, c.signal);
      if (c.signal.aborted) return null;
      setState({ status: 'ready', data, error: null });
      return data;
    } catch (e) {
      if (c.signal.aborted || e.name === 'AbortError') return null;
      setState({ status: 'error', data: null, error: e });
      return null;
    }
  }, []);

  useEffect(() => {
    load(range);
    return () => ctrl.current?.abort();
  }, [range, load]);

  const data = state.data;
  const m = data ? metrics(data.rows, phoneWh) : null;
  const source = data?.health?.source;
  const isSqlite = source === 'sqlite';
  const ready = state.status === 'ready' && m && !m.empty;

  const onCsv = async () => {
    setBusy('csv');
    const fresh = await load(range);           // re-fetch at the moment of the click
    if (fresh && fresh.rows.length) {
      downloadCsv(metrics(fresh.rows, phoneWh).rows, `jolteon-readings-${fileStamp()}.csv`);
    }
    setBusy(null);
  };

  const onPrint = async () => {
    setBusy('print');
    const fresh = await load(range);
    setBusy(null);
    if (fresh && fresh.rows.length) {
      // let React paint the refreshed report before the print dialog opens
      requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    }
  };

  const rangeLabel = (RANGES.find((r) => r.key === range) || RANGES[0]).label;

  return (
    <div className="jl-export">
      <div className="jl-export-screen">
        <Card title="Export readings">
          <div className="jl-card-body jl-export-body">
            <Segmented
              label="Export range"
              value={range}
              onChange={setRange}
              options={RANGES.map((r) => ({ key: r.key, label: r.label }))}
            />

            <div className="jl-export-bar">
              <span className={`jl-export-badge ${isSqlite ? 'jl-export-badge-warn' : ''}`}>
                Source: {source === 'supabase' ? 'Supabase' : source === 'sqlite' ? 'local SQLite' : '—'}
              </span>
              <button type="button" className="jl-btn" onClick={() => load(range)}
                      disabled={state.status === 'loading'}>
                {state.status === 'loading' ? 'Reading…' : 'Refresh'}
              </button>
            </div>

            {isSqlite && (
              <p className="jl-export-warn">
                This is the bridge's local SQLite buffer, not the live Supabase database.
                Anything exported here may be incomplete or stale.
              </p>
            )}

            {state.status === 'loading' && (
              <div className="jl-empty">Reading from the recorder…</div>
            )}

            {state.status === 'error' && (
              <div className="jl-export-error">
                <p>Could not reach the API: {state.error?.message || 'request failed'}</p>
                <button type="button" className="jl-btn" onClick={() => load(range)}>Try again</button>
              </div>
            )}

            {state.status === 'ready' && m?.empty && (
              <div className="jl-empty">No data yet — the recorder has not stored any readings.</div>
            )}

            {ready && (
              <>
                <div className="jl-big">
                  <span className="jl-big-num">{num(m.energyGained, 3)}</span>
                  <span className="jl-unit">Wh gained</span>
                </div>
                <Rows
                  rows={[
                    { label: 'Stored now (latest total)', dot: 'var(--gold)', value: `${num(m.storedNow, 3)} Wh` },
                    { label: 'Charge gained', dot: 'var(--amber)', value: `${signed(m.chargeGained, 1)} mAh` },
                    { label: 'Average power', dot: 'var(--orange)', value: `${num(m.avgPowerW, 4)} W` },
                    { label: 'Peak power', dot: 'var(--orange)', value: `${num(m.peakW, 4)} W` },
                    { label: 'Battery voltage', dot: 'var(--blue)', value: `${num(m.battStart, 3)} → ${num(m.battEnd, 3)} V (${signed(m.battChange, 3)})` },
                    { label: 'Max ΔT', dot: 'var(--hot)', value: `${num(m.maxDt, 1)} °C` },
                    { label: 'Run time', value: span(m.spanMs) },
                    { label: 'Readings', value: m.count.toLocaleString() },
                    { label: 'Phone charge', value: `${num(m.phonePct, 1)} % of ${phoneWh} Wh` },
                  ]}
                />

                <div className="jl-export-actions">
                  <button type="button" className="jl-btn" onClick={onCsv} disabled={busy !== null}>
                    {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
                  </button>
                  <button type="button" className="jl-btn" onClick={onPrint} disabled={busy !== null}>
                    {busy === 'print' ? 'Preparing…' : 'Download PDF report'}
                  </button>
                </div>
                <p className="jl-export-hint">
                  Both re-read the recorder first, so the file matches the data at the moment you click.
                  The PDF opens your browser's print dialog — choose <strong>Save as PDF</strong> as the destination.
                </p>
              </>
            )}
          </div>
        </Card>
      </div>

      {ready && (
        <div className="jl-print-report" aria-hidden="true">
          <h1>Jolteon: Waste-heat recovery report</h1>
          <p className="jl-pr-sub">Generated {localTime(new Date().toISOString())}</p>

          <section className="jl-pr-block">
            <h2>Where this data came from</h2>
            <dl className="jl-pr-trace">
              <div><dt>Data source</dt><dd>{source === 'supabase' ? 'Supabase (live recorder database)' : 'Local SQLite buffer'}</dd></div>
              <div><dt>Fetched at</dt><dd>{localTime(new Date(data.fetchedAt).toISOString())}</dd></div>
              <div><dt>Range</dt><dd>{rangeLabel}</dd></div>
              <div><dt>First reading</dt><dd>{localTime(m.firstTs)}</dd></div>
              <div><dt>Last reading</dt><dd>{localTime(m.lastTs)}</dd></div>
              <div><dt>Readings</dt><dd>{m.count.toLocaleString()}</dd></div>
            </dl>
          </section>

          <section className="jl-pr-block">
            <h2>What we recovered</h2>
            <div className="jl-pr-grid">
              <div className="jl-pr-stat"><span>{num(m.energyGained, 3)}</span><label>Wh gained</label></div>
              <div className="jl-pr-stat"><span>{signed(m.chargeGained, 1)}</span><label>mAh gained</label></div>
              <div className="jl-pr-stat"><span>{num(m.avgPowerW, 4)}</span><label>W average</label></div>
              <div className="jl-pr-stat"><span>{num(m.peakW, 4)}</span><label>W peak</label></div>
              <div className="jl-pr-stat"><span>{span(m.spanMs)}</span><label>run time</label></div>
              <div className="jl-pr-stat"><span>{num(m.phonePct, 1)} %</span><label>of a {phoneWh} Wh phone</label></div>
            </div>
            <p className="jl-pr-note">
              Peak power is the highest single reading of generator voltage × current.
              Average power is the energy gained divided by the elapsed time, which is exact,
              rather than the mean of the samples, which is not.
            </p>
          </section>

          <section className="jl-pr-block">
            <h2>Measurements</h2>
            <dl className="jl-pr-trace jl-pr-trace-wide">
              <div><dt>Stored now (latest counter)</dt><dd>{num(m.storedNow, 5)} Wh / {num(m.chargeNow, 3)} mAh</dd></div>
              <div><dt>Battery voltage</dt><dd>{num(m.battStart, 3)} → {num(m.battEnd, 3)} V ({signed(m.battChange, 3)} V), min {num(m.battMin, 3)}, max {num(m.battMax, 3)}</dd></div>
              <div><dt>Temperature difference</dt><dd>max {num(m.maxDt, 1)} °C, mean {num(m.meanDt, 1)} °C</dd></div>
              <div><dt>Peak hot side</dt><dd>{num(m.peakHot, 1)} °C</dd></div>
              <div><dt>Peak power at</dt><dd>{localTime(m.peakTs)}</dd></div>
              <div><dt>Phase</dt><dd>{m.phases.map((p) => `${p.phase} ${p.rows}`).join(', ')}</dd></div>
            </dl>
          </section>

          <section className="jl-pr-block">
            <h2>Energy stored</h2>
            <PrintChart rows={m.rows} unit="Wh" lines={[{ label: 'energy_wh', color: '#e2ac00', value: (r) => r.energy_wh }]} />
          </section>

          <section className="jl-pr-block">
            <h2>Power generated</h2>
            <PrintChart rows={m.rows} unit="W" lines={[{ label: 'generator', color: '#e8590c',
              value: (r) => (Number.isFinite(r.gen_v) && Number.isFinite(r.gen_ma) ? (r.gen_v * r.gen_ma) / 1000 : NaN) }]} />
          </section>

          <section className="jl-pr-block">
            <h2>Plate temperatures</h2>
            <PrintChart rows={m.rows} unit="°C" lines={[
              { label: 'hot', color: '#c62828', value: (r) => r.t_hot_c },
              { label: 'cold', color: '#2e92ea', value: (r) => r.t_cold_c },
              { label: 'ΔT', color: '#8a6a00', value: (r) => r.delta_t_c },
            ]} />
          </section>

          <section className="jl-pr-block">
            <h2>Battery voltage</h2>
            <PrintChart rows={m.rows} unit="V" lines={[{ label: 'batt_v', color: '#2e92ea', value: (r) => r.batt_v }]} />
          </section>

          <footer className="jl-pr-foot">
            {m.resets > 0 && <p>{m.resets} counter reset{m.resets > 1 ? 's' : ''} detected; totals are summed per segment.</p>}
            {m.missingTemps > 0 && <p>{m.missingTemps} reading{m.missingTemps > 1 ? 's' : ''} had no temperature probe value; those are skipped, not counted as zero.</p>}
            <p>Timestamps are bridge-receive times, shown in local time. Charts are drawn from up to 600 evenly spaced samples; every number above is computed from all {m.count.toLocaleString()} readings.</p>
          </footer>
        </div>
      )}
    </div>
  );
}
