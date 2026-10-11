// Scale projection: fit the rig's real readings, then project to a data center.
// Pure functions, no React, so the numbers can be checked outside the browser.

// TEG modules on the demo rig; the fit is for all of them together.
export const RIG_MODULES = 4;

// Readings below this are the rig idling (or a reversed current), not generation.
const MIN_GEN_W = 0.01;
const BIN_C = 5; // fit on 5 °C ΔT bins
const MIN_BIN_COUNT = 3; // ignore bins too thin to trust

// Typical ΔT a TEG could see in each setting. The rig preset is filled in from the data.
export const PRESETS = [
  { key: 'air', label: 'Air-cooled', dt: 15 },
  { key: 'liquid', label: 'Liquid-cooled', dt: 30 },
  { key: 'rig', label: 'Our rig', dt: null },
];

export const DEFAULTS = { racks: 100, serversPerRack: 30, modulesPerServer: 4, sensorMw: 10, serverW: 500 };

// Heat one home uses in a year, roughly typical of homes on Nordic district-heating
// networks. Only used for the "same heat, reused" comparison, and labelled as such.
export const HOME_HEAT_MWH_PER_YEAR = 15;

// Average draw of a sleepy wireless temperature/flow node.
export const SENSOR_MW_OPTIONS = [1, 5, 10];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Readings that describe the TEGs generating: both probes present and real output.
export function cleanPoints(rows) {
  return (rows || [])
    .filter((r) => Number.isFinite(r.delta_t_c) && r.delta_t_c > 0 && Number.isFinite(r.gen_w) && r.gen_w > MIN_GEN_W)
    .map((r) => ({ dt: r.delta_t_c, w: r.gen_w }));
}

// Fit P = a * ΔT^n (whole rig) through the median of each ΔT bin. Medians keep
// thermal lag and noisy single readings from dragging the curve. Returns null
// until there are at least two usable bins.
export function fitPowerLaw(points) {
  const groups = new Map();
  points.forEach((p) => {
    const k = Math.floor(p.dt / BIN_C);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  });
  const bins = [...groups.entries()]
    .filter(([, g]) => g.length >= MIN_BIN_COUNT)
    .map(([k, g]) => ({ lo: k * BIN_C, dt: median(g.map((p) => p.dt)), w: median(g.map((p) => p.w)), count: g.length }))
    .sort((a, b) => a.dt - b.dt);
  if (bins.length < 2) return null;

  // Least squares on log-log: ln P = ln a + n ln ΔT
  const xs = bins.map((b) => Math.log(b.dt));
  const ys = bins.map((b) => Math.log(b.w));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
  });
  if (sxx === 0) return null;
  const n = sxy / sxx;
  const a = Math.exp(my - n * mx);
  return {
    a,
    n,
    bins,
    count: points.length,
    dtMin: Math.min(...points.map((p) => p.dt)),
    dtMax: Math.max(...points.map((p) => p.dt)),
    dtMedian: median(points.map((p) => p.dt)),
  };
}

// Fitted output of the whole rig at a given ΔT, in W.
// The fitted bin holding this ΔT (its median reading), or null if no bin has enough readings there.
export const binAt = (fit, dt) => (fit ? fit.bins.find((b) => dt >= b.lo && dt < b.lo + BIN_C) || null : null);

export const rigPowerAt = (fit, dt) => (fit && dt > 0 ? fit.a * dt ** fit.n : 0);

export const modulePowerAt = (fit, dt) => rigPowerAt(fit, dt) / RIG_MODULES;

export const isExtrapolated = (fit, dt) => !!fit && (dt < fit.dtMin || dt > fit.dtMax);

// TEG outputs are NaN until there is a fit, so the UI shows "—" rather than a fake 0.
export function project(fit, { dt, racks, serversPerRack, modulesPerServer, sensorMw, serverW }) {
  // Facility heat needs no fit: nearly every watt a server draws leaves it as heat.
  const heatW = racks * serversPerRack * serverW;
  const homesHeated = (heatW * 24 * 365) / (HOME_HEAT_MWH_PER_YEAR * 1e6);
  if (!fit) {
    return { moduleW: NaN, rackW: NaN, totalW: NaN, dayWh: NaN, yearWh: NaN, sensorsPerRack: NaN, sensorsTotal: NaN,
      heatW, recoveredShare: NaN, homesHeated };
  }
  const moduleW = modulePowerAt(fit, dt);
  const rackW = moduleW * serversPerRack * modulesPerServer;
  const totalW = rackW * racks;
  const dayWh = totalW * 24;
  const sensorsPerRack = Math.floor((rackW * 1000) / sensorMw);
  return {
    moduleW,
    rackW,
    totalW,
    dayWh,
    yearWh: dayWh * 365,
    sensorsPerRack,
    sensorsTotal: sensorsPerRack * racks,
    heatW,
    recoveredShare: totalW / heatW,
    homesHeated,
  };
}
