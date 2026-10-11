import { useMemo, useState } from 'react';
import CurveChart from './CurveChart';
import {
  cleanPoints,
  DEFAULTS,
  fitPowerLaw,
  HOME_HEAT_MWH_PER_YEAR,
  isExtrapolated,
  PRESETS,
  project,
  RIG_MODULES,
  SENSOR_MW_OPTIONS,
} from './scaleModel';
import { useAllReadings } from './useDashboardData';
import './scale.css';

const fixed = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const count = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

// Pick the unit so the number stays readable from 1 mW to 10 MW.
function power(w) {
  if (!Number.isFinite(w)) return { v: '—', u: 'W' };
  if (w >= 1e6) return { v: fixed(w / 1e6, 2), u: 'MW' };
  if (w >= 1e3) return { v: fixed(w / 1e3, 2), u: 'kW' };
  if (w >= 1) return { v: fixed(w, 2), u: 'W' };
  return { v: fixed(w * 1e3, 1), u: 'mW' };
}
function energy(wh) {
  if (!Number.isFinite(wh)) return '—';
  if (wh >= 1e6) return `${fixed(wh / 1e6, 2)} MWh`;
  if (wh >= 1e3) return `${fixed(wh / 1e3, 2)} kWh`;
  return `${fixed(wh, 1)} Wh`;
}
// Recovered shares are tiny, so keep two significant figures instead of rounding to 0.
function pct(f) {
  if (!Number.isFinite(f)) return '—';
  const p = f * 100;
  return `${p >= 1 ? p.toFixed(1) : p.toPrecision(2)} %`;
}
const pw = (w) => {
  const p = power(w);
  return `${p.v} ${p.u}`;
};

// Racks run 1 -> 10,000 on a log slider, snapped to 1-2-5 style round numbers.
const RACK_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

// 0.0000127 -> 1.27 × 10⁻⁵, so the fit constant reads like a number, not code.
function sci(v) {
  if (!Number.isFinite(v)) return '—';
  const e = Math.floor(Math.log10(Math.abs(v)));
  return (
    <>
      {fixed(v / 10 ** e, 2)} × 10<sup>{e}</sup>
    </>
  );
}

// One line of the worked math: what it is, the formula with numbers in, the result.
function MathStep({ n, title, formula, result }) {
  return (
    <li className="jl-math-step">
      <span className="jl-math-n">{n}</span>
      <div className="jl-math-body">
        <div className="jl-math-title">{title}</div>
        <div className="jl-math-formula">
          {formula} = <strong>{result}</strong>
        </div>
      </div>
    </li>
  );
}

function Slider({ label, value, display, min, max, step = 1, onChange }) {
  return (
    <label className="jl-slider">
      <span className="jl-slider-head">
        <span className="jl-slider-label">{label}</span>
        <span className="jl-slider-value">{display ?? value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export default function Scale({ Card, Rows, Segmented, phoneWh }) {
  const all = useAllReadings();
  const points = useMemo(() => cleanPoints(all.data), [all.data]);
  const fit = useMemo(() => fitPowerLaw(points), [points]);

  const [preset, setPreset] = useState('liquid');
  const [customDt, setCustomDt] = useState(null); // set once the slider is dragged
  const [rackIdx, setRackIdx] = useState(RACK_STEPS.indexOf(DEFAULTS.racks));
  const [serversPerRack, setServersPerRack] = useState(DEFAULTS.serversPerRack);
  const [modulesPerServer, setModulesPerServer] = useState(DEFAULTS.modulesPerServer);
  const [sensorMw, setSensorMw] = useState(DEFAULTS.sensorMw);
  const [serverW, setServerW] = useState(DEFAULTS.serverW);
  const [mathOpen, setMathOpen] = useState(false);

  const presetDt = (key) => {
    const p = PRESETS.find((x) => x.key === key);
    return p.dt ?? (fit ? Math.round(fit.dtMedian) : 80);
  };
  const dt = customDt ?? presetDt(preset);
  const racks = RACK_STEPS[rackIdx];
  const out = project(fit, { dt, racks, serversPerRack, modulesPerServer, sensorMw, serverW });
  const extrapolated = isExtrapolated(fit, dt);
  const total = power(out.totalW);
  const nowModuleW = fit ? fit.a * fit.dtMedian ** fit.n / RIG_MODULES : NaN;

  const choosePreset = (key) => {
    setPreset(key);
    setCustomDt(null);
  };

  return (
    <div className="jl-scale">
      <Card title="What we measured">
        <div className="jl-card-body jl-scale-measured">
          <CurveChart
            points={points}
            fit={fit}
            markDt={dt}
            onPick={setCustomDt}
            status={all.loaded ? 'ready' : 'loading'}
          />
          <div className="jl-scale-side">
            <p className="jl-scale-note">
              Every dot is one real reading from the rig. The curve is fitted through them, and every number on this
              page comes from that curve. Solid where we have data, dashed where it extrapolates. Hover to compare
              the curve with the readings, and click to try that ΔT in the calculator.
            </p>
            <Rows
              rows={[
                { label: 'Readings used', dot: 'var(--orange)', value: count(fit?.count) },
                { label: 'ΔT measured', value: fit ? `${fixed(fit.dtMin, 0)}–${fixed(fit.dtMax, 0)} °C` : '—' },
                { label: 'Power grows as', dot: 'var(--gold)', value: fit ? <>ΔT<sup>{fixed(fit.n, 2)}</sup></> : '—' },
                { label: `Per module at ${fit ? fixed(fit.dtMedian, 0) : '—'} °C`, value: pw(nowModuleW) },
              ]}
            />
          </div>
        </div>
      </Card>

      <div className="jl-scale-grid">
        <Card title="Scale it up">
          <div className="jl-card-body">
            <Segmented
              label="Cooling type"
              value={customDt == null ? preset : ''}
              onChange={choosePreset}
              options={PRESETS.map((p) => ({ key: p.key, label: p.label }))}
            />
            <Slider
              label="Temperature difference"
              value={dt}
              display={`${dt} °C`}
              min={5}
              max={120}
              onChange={setCustomDt}
            />
            {extrapolated && (
              <div className="jl-scale-tag">
                Extrapolated: the rig was measured at {fixed(fit.dtMin, 0)}–{fixed(fit.dtMax, 0)} °C
              </div>
            )}
            <Slider label="Racks" value={rackIdx} display={count(racks)} min={0} max={RACK_STEPS.length - 1} onChange={setRackIdx} />
            <Slider label="Servers per rack" value={serversPerRack} min={1} max={60} onChange={setServersPerRack} />
            <Slider label="TEG modules per server" value={modulesPerServer} min={1} max={12} onChange={setModulesPerServer} />
            <Slider
              label="Power per server"
              value={serverW}
              display={`${serverW} W`}
              min={100}
              max={1500}
              step={50}
              onChange={setServerW}
            />

            <div className="jl-big">
              <span className="jl-big-num">{total.v}</span>
              <span className="jl-unit">{total.u} across the facility</span>
            </div>
            <Rows
              rows={[
                { label: 'Per module', dot: 'var(--orange)', value: pw(out.moduleW) },
                { label: 'Per rack', dot: 'var(--amber)', value: pw(out.rackW) },
                { label: 'Energy per day', dot: 'var(--gold)', value: energy(out.dayWh) },
                { label: 'Energy per year', value: energy(out.yearWh) },
                { label: 'Phones charged per day', value: count(out.dayWh / phoneWh) },
                { label: 'Heat the facility gives off', dot: 'var(--hot)', value: pw(out.heatW) },
                { label: 'Share of that heat recovered', value: pct(out.recoveredShare) },
              ]}
            />
          </div>
        </Card>

        <Card title="Self-powered sensors">
          <div className="jl-card-body">
            <p className="jl-scale-note">
              Every rack already gives off heat. A few TEGs on each one turn some of it back into power, enough to run
              the sensors that watch that rack, with no wiring, no batteries and no extra draw from the grid.
            </p>
            <div className="jl-big">
              <span className="jl-big-num">{count(out.sensorsPerRack)}</span>
              <span className="jl-unit">sensors per rack</span>
            </div>
            <Segmented
              label="Sensor power budget"
              value={sensorMw}
              onChange={setSensorMw}
              options={SENSOR_MW_OPTIONS.map((mw) => ({ key: mw, label: `${mw} mW` }))}
            />
            <Rows
              rows={[
                { label: 'Across the facility', dot: 'var(--gold)', value: count(out.sensorsTotal) },
                { label: 'Rack power available', dot: 'var(--amber)', value: pw(out.rackW) },
                { label: 'Each sensor draws', value: `${sensorMw} mW avg` },
              ]}
            />
            <p className="jl-scale-note jl-scale-small">
              A sensor that sleeps between readings averages 1–10 mW. 10 mW is the cautious end.
            </p>
          </div>
        </Card>
      </div>

      <Card title="Why it matters">
        <div className="jl-raw-body">
          <p className="jl-scale-note">
            Data centers are pulling more power than many city grids were built for, and nearly every watt they draw
            ends up as heat. TEGs won't take a data center off the grid. Here's where they help.
          </p>
          <ol className="jl-math">
            <MathStep
              n="1"
              title="The heat is already there"
              formula={
                <>
                  {count(racks * serversPerRack)} servers × {serverW} W, all ending up as heat
                </>
              }
              result={pw(out.heatW)}
            />
            <MathStep
              n="2"
              title="TEGs turn a sliver of it back into power"
              formula={<>{pct(out.recoveredShare)} of that heat recovered</>}
              result={pw(out.totalW)}
            />
            <MathStep
              n="3"
              title="Enough to run sensors on every rack, battery-free"
              formula={<>{pw(out.totalW)} ÷ {sensorMw} mW per sensor</>}
              result={`${count(out.sensorsTotal)} sensors`}
            />
            <MathStep
              n="4"
              title="Finer heat maps let cooling target hot spots instead of chilling the whole room"
              formula={<>Cooling is the biggest energy cost after the servers, so less cooling</>}
              result="less load on the grid"
            />
          </ol>
          <div className="jl-rows jl-scale-wrap">
            <div className="jl-row">
              <span className="jl-row-label">
                <span className="jl-row-dot" style={{ background: 'var(--hot)' }} />
                <span>The bigger lever: the same heat, piped to district heating</span>
              </span>
              <span className="jl-row-value">≈ {count(out.homesHeated)} homes</span>
            </div>
          </div>
          <p className="jl-scale-note jl-scale-small">
            Homes estimate assumes about {HOME_HEAT_MWH_PER_YEAR} MWh of heat per home per year, typical of Nordic
            district-heating networks, and that all of the facility's heat is captured. TEGs and heat reuse work
            together: TEGs power the monitoring, reuse moves the bulk of the heat.
          </p>
        </div>
      </Card>

      <Card title="Show the math">
        <div className="jl-raw-body">
          <div className="jl-raw-head">
            <p>
              Every step from the rig's readings to the numbers above, with the current settings plugged in. It updates
              as you move the sliders.
            </p>
            <button type="button" className="jl-btn" aria-expanded={mathOpen} onClick={() => setMathOpen((o) => !o)}>
              {mathOpen ? 'Hide the math' : 'Show the math'}
            </button>
          </div>
          {mathOpen && fit && (
            <ol className="jl-math">
              <MathStep
                n="1"
                title={`Fit the rig's readings: power grows as a power of ΔT`}
                formula={
                  <>
                    P<sub>rig</sub> = a · ΔT<sup>n</sup>, a = {sci(fit.a)}, n
                  </>
                }
                result={fixed(fit.n, 2)}
              />
              <li className="jl-math-note">
                {count(fit.count)} readings, grouped into {fit.bins.length} bins of 5 °C. Each bin's median ΔT and median
                power are fitted with a straight line on log-log axes, so one noisy reading can't pull the curve. Bins
                with fewer than 3 readings are skipped.
              </li>
              <MathStep
                n="2"
                title={`Rig output at ΔT = ${dt} °C`}
                formula={
                  <>
                    {sci(fit.a)} × {dt}
                    <sup>{fixed(fit.n, 2)}</sup>
                  </>
                }
                result={pw(out.moduleW * RIG_MODULES)}
              />
              <MathStep
                n="3"
                title="Per module (the rig has 4)"
                formula={<>{pw(out.moduleW * RIG_MODULES)} ÷ {RIG_MODULES}</>}
                result={pw(out.moduleW)}
              />
              <MathStep
                n="4"
                title="Per rack"
                formula={
                  <>
                    {pw(out.moduleW)} × {serversPerRack} servers × {modulesPerServer} modules
                  </>
                }
                result={pw(out.rackW)}
              />
              <MathStep
                n="5"
                title="Whole facility"
                formula={
                  <>
                    {pw(out.rackW)} × {count(racks)} racks
                  </>
                }
                result={pw(out.totalW)}
              />
              <MathStep
                n="6"
                title="Energy per day and per year"
                formula={<>{pw(out.totalW)} × 24 h, then × 365</>}
                result={`${energy(out.dayWh)} / day, ${energy(out.yearWh)} / year`}
              />
              <MathStep
                n="7"
                title="Phones charged per day"
                formula={<>{energy(out.dayWh)} ÷ {phoneWh} Wh per phone</>}
                result={count(out.dayWh / phoneWh)}
              />
              <MathStep
                n="8"
                title="Sensors each rack can power (rounded down)"
                formula={<>{pw(out.rackW)} ÷ {sensorMw} mW per sensor</>}
                result={count(out.sensorsPerRack)}
              />
              <MathStep
                n="9"
                title="Heat the facility gives off (nearly all server power becomes heat)"
                formula={
                  <>
                    {count(racks)} racks × {serversPerRack} servers × {serverW} W
                  </>
                }
                result={pw(out.heatW)}
              />
              <MathStep
                n="10"
                title="Share of that heat the TEGs recover"
                formula={<>{pw(out.totalW)} ÷ {pw(out.heatW)}</>}
                result={pct(out.recoveredShare)}
              />
              <MathStep
                n="11"
                title="Homes the same heat could warm through district heating"
                formula={
                  <>
                    {pw(out.heatW)} × 8,760 h ÷ {HOME_HEAT_MWH_PER_YEAR} MWh per home
                  </>
                }
                result={count(out.homesHeated)}
              />
            </ol>
          )}
          {mathOpen && !fit && <p className="jl-math-note">Waiting for enough readings to fit…</p>}
        </div>
      </Card>

      <footer className="jl-foot">
        Our rig runs at a ΔT of about {fit ? fixed(fit.dtMedian, 0) : '—'} °C, far more than a data center offers. Air-cooled servers give about
        15 °C and liquid-cooled racks about 30 °C, which is why those presets are lower. The rig's battery holds the
        TEG voltage down, so these projections are a lower bound; a DC-DC converter (MPPT) would raise them.
      </footer>
    </div>
  );
}
