import { useId, useRef } from 'react';

const W = 600;
const H = 170;
const PT = 16; // top / bottom padding inside the plot, in viewBox units
const PB = 12;

const clock = (ms, withSeconds) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}${withSeconds ? ':' + p(d.getSeconds()) : ''}`;
};

/**
 * Minimal SVG line chart.
 *  times      array of ms timestamps (oldest first)
 *  series     [{ values: number[], color: 'var(--blue)' }]
 *  band       true -> fill the area BETWEEN series[0] and series[1] (temperatures)
 *             false -> fade-out area under series[0]
 *  hoverFrac  0..1 shared across all charts (same time axis), or null
 *  onHover    (frac | null) => void
 *  tip        (index) => string, the exact value shown in the tooltip
 *
 * The y-axis is zoomed to the data in view ("auto-zoom"), so tiny movements
 * (e.g. battery voltage) are visible. Values are never altered.
 */
export default function Chart({ times, series, band, hoverFrac, onHover, tip, withSeconds, status }) {
  const gid = 'g' + useId().replace(/:/g, '');
  const plotRef = useRef(null);
  const n = times.length;

  if (n < 2) {
    return (
      <div className="jl-well">
        <div className="jl-empty">{status === 'loading' ? 'Loading…' : 'Collecting data…'}</div>
      </div>
    );
  }

  // y scale across all series
  let min = Infinity;
  let max = -Infinity;
  series.forEach((s) =>
    s.values.forEach((v) => {
      if (v < min) min = v;
      if (v > max) max = v;
    }),
  );
  let span = max - min;
  if (span < 1e-9) {
    span = Math.abs(max) * 0.01 || 1;
    min -= span / 2;
    max += span / 2;
  }
  const pad = span * 0.1;
  min -= pad;
  max += pad;
  const y = (v) => PT + (1 - (v - min) / (max - min)) * (H - PT - PB);

  // x is true time, so uneven packet spacing is drawn honestly
  const t0 = times[0];
  const t1 = times[n - 1];
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
  const ys = series.map((s) => s.values.map(y));
  const xs = times.map(x);
  const path = (arr) => arr.map((yy, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)} ${yy.toFixed(1)}`).join(' ');

  let fillD;
  if (band && ys[1]) {
    fillD = path(ys[0]);
    for (let i = n - 1; i >= 0; i--) fillD += ` L${xs[i].toFixed(1)} ${ys[1][i].toFixed(1)}`;
    fillD += ' Z';
  } else {
    fillD = `${path(ys[0])} L${W} ${H} L0 ${H} Z`;
  }

  // hover -> nearest point
  const hovering = hoverFrac != null;
  let idx = n - 1;
  if (hovering) {
    const target = t0 + hoverFrac * (t1 - t0);
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(times[i] - target);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
  }
  const xPct = (xs[idx] / W) * 100;
  const pillLeft = Math.min(74, Math.max(26, xPct));
  const topPct = (yy) => ((yy / H) * 100).toFixed(2) + '%';

  const move = (e) => {
    const r = plotRef.current.getBoundingClientRect();
    onHover(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };

  return (
    <div className="jl-well">
      <div
        className="jl-chart"
        onPointerMove={move}
        onPointerLeave={() => onHover(null)}
        onPointerCancel={() => onHover(null)}
      >
        <div className="jl-plot" ref={plotRef}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: series[0].color, stopOpacity: 0.32 }} />
                <stop offset="1" style={{ stopColor: series[0].color, stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            <path d={fillD} style={{ fill: band ? 'var(--band)' : `url(#${gid})`, stroke: 'none' }} />
            {series.map((s, k) => (
              <g key={k}>
                {s.outline && (
                  <path
                    d={path(ys[k])}
                    vectorEffect="non-scaling-stroke"
                    style={{ fill: 'none', stroke: s.outline, strokeWidth: 5.6, strokeLinejoin: 'round', strokeLinecap: 'round' }}
                  />
                )}
                <path
                  d={path(ys[k])}
                  vectorEffect="non-scaling-stroke"
                  style={{ fill: 'none', stroke: s.color, strokeWidth: s.outline ? 3 : 3.2, strokeLinejoin: 'round', strokeLinecap: 'round' }}
                />
              </g>
            ))}
          </svg>

          {hovering && <div className="jl-vline" style={{ left: xPct + '%' }} />}
          {hovering &&
            series.map((s, k) => (
              <div
                key={'h' + k}
                className="jl-hdot"
                style={{ left: xPct + '%', top: topPct(ys[k][idx]), borderColor: s.color }}
              />
            ))}
          {series.map((s, k) => (
            <div
              key={'e' + k}
              className="jl-edot jl-pulse"
              style={{ top: topPct(ys[k][n - 1]), background: s.color, boxShadow: `0 0 0 1px ${s.color}` }}
            />
          ))}
        </div>

        {hovering && (
          <div className="jl-pill" style={{ left: pillLeft + '%' }}>
            {clock(times[idx], withSeconds)} · {tip(idx)}
          </div>
        )}
      </div>
      <div className="jl-axis">
        <span>{clock(t0, withSeconds)}</span>
        <span>now</span>
      </div>
    </div>
  );
}
