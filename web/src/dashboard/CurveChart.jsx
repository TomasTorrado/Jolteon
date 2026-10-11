import { useRef, useState } from 'react';
import { binAt, isExtrapolated, rigPowerAt } from './scaleModel';

const W = 600;
const H = 330;
const L = 58; // room for the y labels
const R = 14;
const T = 34; // room for the "W" axis title
const B = 70; // room for the x labels and the "ΔT °C" axis title
const X_MAX = 130;
// The calculator's ΔT slider range; a click is clamped into it.
const PICK_MIN = 5;
const PICK_MAX = 120;

const watts = (w) => (w >= 1 ? `${w.toFixed(2)} W` : `${(w * 1000).toFixed(w < 0.01 ? 1 : 0)} mW`);

/**
 * Scatter of every reading's TEG power against ΔT, with the fitted curve.
 *  points  [{ dt, w }] (whole rig)
 *  fit     from fitPowerLaw, or null
 *  markDt  the ΔT selected in the calculator, marked with a dot on the curve
 *  onPick  (dt) => void, called with a whole-degree ΔT when the chart is clicked
 *
 * Hovering shows, at that ΔT, the curve's value next to the median of the real
 * readings in the same 5 °C bin, so the fit can be checked by eye. Dots are not
 * snapped to: there are hundreds and they overlap.
 *
 * Unlike Chart.jsx this keeps its aspect ratio, so the dots stay round. The
 * curve is solid over the measured ΔT range and dashed where it extrapolates.
 */
export default function CurveChart({ points, fit, markDt, onPick, status }) {
  const svgRef = useRef(null);
  const [hoverDt, setHoverDt] = useState(null);

  if (!fit) {
    return (
      <div className="jl-well">
        <div className="jl-empty">{status === 'loading' ? 'Loading…' : 'Not enough readings to fit yet…'}</div>
      </div>
    );
  }

  const wMax = Math.max(...points.map((p) => p.w), rigPowerAt(fit, X_MAX)) * 1.05;
  const step = niceStep(wMax / 4);
  const yMax = step * Math.ceil(wMax / step);
  const x = (dt) => L + (dt / X_MAX) * (W - L - R);
  const y = (w) => T + (1 - w / yMax) * (H - T - B);

  const curve = (from, to) => {
    const pts = [];
    for (let dt = from; dt <= to + 1e-9; dt += (to - from) / 60) pts.push(`${x(dt).toFixed(1)},${y(rigPowerAt(fit, dt)).toFixed(1)}`);
    return 'M' + pts.join(' L');
  };

  const yTicks = [];
  for (let v = 0; v <= yMax + step / 2; v += step) yTicks.push(v);
  const yDecimals = (String(+step.toPrecision(3)).split('.')[1] || '').length; // 0.25 -> 2, 0.5 -> 1
  const xTicks = [0, 20, 40, 60, 80, 100, 120];
  const markW = rigPowerAt(fit, markDt);

  // Pointer position -> ΔT, or null outside the plot area.
  const dtFromEvent = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const dt = ((vx - L) / (W - L - R)) * X_MAX;
    return dt >= 0 && dt <= X_MAX ? dt : null;
  };
  const pick = (e) => {
    const dt = dtFromEvent(e);
    if (dt != null && onPick) onPick(Math.min(PICK_MAX, Math.max(PICK_MIN, Math.round(dt))));
  };

  const hover = hoverDt == null ? null : Math.round(hoverDt);
  const bin = hover == null ? null : binAt(fit, hover);

  return (
    <div className="jl-well">
      <div className="jl-curve-wrap">
        <svg
          ref={svgRef}
          className="jl-curve"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="TEG power against temperature difference. Click to set the calculator's temperature difference."
          onPointerMove={(e) => setHoverDt(dtFromEvent(e))}
          onPointerLeave={() => setHoverDt(null)}
          onPointerCancel={() => setHoverDt(null)}
          onClick={pick}
        >
          {yTicks.map((v) => (
            <g key={'y' + v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="jl-curve-grid" />
              <text x={L - 10} y={y(v) + 7} textAnchor="end" className="jl-curve-label">
                {v.toFixed(yDecimals)}
              </text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={'x' + v} x={x(v)} y={H - B + 28} textAnchor="middle" className="jl-curve-label">
              {v}
            </text>
          ))}
          <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" className="jl-curve-label jl-curve-unit">
            ΔT (°C)
          </text>
          <text x={L - 10} y={T - 14} textAnchor="end" className="jl-curve-label jl-curve-unit">
            W
          </text>

          {/* measured range, so it is obvious where the curve stops being data */}
          <rect x={x(fit.dtMin)} y={T} width={x(fit.dtMax) - x(fit.dtMin)} height={H - T - B} className="jl-curve-range" />

          {points.map((p, i) => (
            <circle key={i} cx={x(p.dt)} cy={y(p.w)} r="3.5" className="jl-curve-pt" />
          ))}

          <path d={curve(5, fit.dtMin)} className="jl-curve-fit jl-curve-extra" />
          <path d={curve(fit.dtMax, X_MAX)} className="jl-curve-fit jl-curve-extra" />
          <path d={curve(fit.dtMin, fit.dtMax)} className="jl-curve-fit" />

          {markDt > 0 && markDt <= X_MAX && (
            <g>
              <line x1={x(markDt)} x2={x(markDt)} y1={T} y2={H - B} className="jl-curve-mark-line" />
              <circle cx={x(markDt)} cy={y(markW)} r="8" className="jl-curve-mark" />
            </g>
          )}

          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="jl-curve-hover-line" />
              <circle cx={x(hover)} cy={y(rigPowerAt(fit, hover))} r="7" className="jl-curve-hover" />
              {bin && <circle cx={x(hover)} cy={y(bin.w)} r="6" className="jl-curve-hover jl-curve-hover-data" />}
            </g>
          )}
        </svg>

        {hover != null && (
          <div className="jl-pill jl-curve-pill">
            ΔT {hover} °C · curve {watts(rigPowerAt(fit, hover))}
            <br />
            <span className="jl-curve-pill-sub">
              {bin
                ? `measured ${watts(bin.w)} (${bin.count} readings)`
                : isExtrapolated(fit, hover)
                  ? 'extrapolated, no readings here'
                  : 'too few readings here'}
              {onPick && ' · click to use'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Round tick spacing (1, 2, 2.5 or 5 times a power of ten) at least v,
// so every gridline lands on a round number.
function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].find((s) => s * p >= v) * p;
}
