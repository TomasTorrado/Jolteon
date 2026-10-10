import { useEffect, useMemo, useState } from 'react';
import Chart from './Chart';
import { useDashboardData, useReadings, WINDOWS } from './useDashboardData';
import logo from './assets/jolteon-logo.png';
import trio from './assets/eeveelutions.png';
import './dashboard.css';

// Approximate phone battery energy. Check against the exact spec you want to quote.
// TO CHANGE IT: edit this one line. Nothing else hardcodes the figure -- both the
// Phone tab's ring percentage and its "<x> Wh stored of <y> Wh" caption read PHONE_WH,
// so they stay in step automatically.
const PHONE_WH = 13.9;

const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const signed = (v, d) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '—');
const clock = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const duration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return `${h}h ${String(m).padStart(2, '0')}m`;
};

function useNow(intervalMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('jolteon-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* storage blocked, fall through */
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const toggle = () =>
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('jolteon-theme', next);
      } catch {
        /* ignore */
      }
      return next;
    });
  return [theme, toggle];
}

function Bolt({ size = 18, off = false }) {
  return (
    <svg
      className={`jl-bolt${off ? ' jl-bolt-off' : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <path d="M13.5 1.5 4 13.5h6.2L9 22.5l10-12.4h-6.3z" />
    </svg>
  );
}

function Segmented({ label, options, value, onChange, className = '' }) {
  return (
    <div role="group" aria-label={label} className={`jl-seg ${className}`}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.live && <Bolt size={18} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function Ring({ pct }) {
  const R = 86;
  const C = 2 * Math.PI * R;
  const shown = Math.max(0, Math.min(100, pct || 0));
  return (
    <div className="jl-ring">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r={R} className="jl-ring-track" />
        <circle
          cx="100"
          cy="100"
          r={R}
          className="jl-ring-fill"
          strokeDasharray={`${(shown / 100) * C} ${C}`}
        />
      </svg>
      <div className="jl-ring-inner">
        <span>{Number.isFinite(pct) ? Math.round(pct) : '—'}%</span>
      </div>
    </div>
  );
}

function Rows({ rows }) {
  return (
    <div className="jl-rows">
      {rows.map((r) => (
        <div className="jl-row" key={r.label}>
          <div className="jl-row-label">
            {r.dot && <span className="jl-row-dot" style={{ background: r.dot }} />}
            <span>{r.label}</span>
          </div>
          <span className="jl-row-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

// One chart card. It owns its time range, its history poll and its hover,
// so switching Live / 12h / 24h here leaves the other cards alone.
function ChartCard({ title, big, unit, band, series, tip, rows }) {
  const [win, setWin] = useState('live'); // 'live' | '12h' | '24h'
  const [hover, setHover] = useState(null); // 0..1 within this chart
  const readings = useReadings(win);
  const rs = readings.data || [];
  const times = useMemo(() => rs.map((r) => Date.parse(r.ts)), [rs]);
  const isLive = win === 'live';
  const ctx = { rs, isLive };

  return (
    <article className="jl-card">
      <h2 className="jl-card-title">{title}</h2>

      <Segmented
        label="Time range"
        value={win}
        onChange={setWin}
        options={Object.entries(WINDOWS).map(([key, w]) => ({ key, label: w.label, live: key === 'live' }))}
      />

      <div className="jl-big">
        <span className="jl-big-num">{big}</span>
        <span className="jl-unit">{unit}</span>
      </div>

      <Chart
        times={times}
        series={series(rs)}
        band={band}
        hoverFrac={hover}
        onHover={setHover}
        tip={(i) => tip(rs, i)}
        withSeconds={isLive}
        status={readings.loaded ? 'ready' : 'loading'}
      />

      <Rows rows={rows(ctx)} />
    </article>
  );
}

export default function Dashboard() {
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState('charts'); // 'charts' | 'phone'
  const [rawOpen, setRawOpen] = useState(false);
  const now = useNow(5000);

  const { latest, summary, recent } = useDashboardData();
  const L = latest.data; // newest reading, or null
  const S = summary.data;

  // ---- connection status for the header pill ----
  let status = 'live';
  let statusText = 'Live';
  if (latest.error) {
    status = 'off';
    statusText = "Can't reach the API";
  } else if (!latest.loaded) {
    status = 'off';
    statusText = 'Connecting…';
  } else if (!L) {
    status = 'off';
    statusText = 'Waiting for first reading';
  } else if ((now - Date.parse(L.ts)) / 1000 > 20) {
    status = 'off';
    statusText = 'No new data';
  }

  // ---- chart cards ----
  const cards = [
    {
      key: 'energy',
      title: 'Energy stored',
      big: num(L?.energy_wh, 3),
      unit: 'Wh',
      band: false,
      series: (rs) => [{ values: rs.map((r) => r.energy_wh), color: 'var(--gold)', outline: 'var(--gold-d)' }],
      tip: (rs, i) => `${num(rs[i].energy_wh, 3)} Wh`,
      rows: ({ rs, isLive }) => [
        {
          label: 'Gained',
          dot: 'var(--gold)',
          value:
            rs.length > 1
              ? `${signed(rs[rs.length - 1].energy_wh - rs[0].energy_wh, isLive ? 4 : 2)} Wh`
              : '—',
        },
      ],
    },
    {
      key: 'power',
      title: 'Power',
      big: num(L?.gen_w, 3),
      unit: 'W',
      band: false,
      series: (rs) => [{ values: rs.map((r) => r.gen_w), color: 'var(--orange)' }],
      tip: (rs, i) => `${num(rs[i].gen_w, 3)} W`,
      rows: () => [
        { label: 'Battery voltage', dot: 'var(--orange)', value: `${num(L?.batt_v, 3)} V` },
        { label: 'Current', dot: 'var(--amber)', value: `${signed(L?.batt_ma, 1)} mA` },
      ],
    },
    {
      key: 'temp',
      title: 'Temperature difference',
      big: num(L?.delta_t_c, 1),
      unit: '°C',
      band: true,
      series: (rs) => [
        { values: rs.map((r) => r.t_hot_c), color: 'var(--hot)' },
        { values: rs.map((r) => r.t_cold_c), color: 'var(--cold)' },
      ],
      tip: (rs, i) => `Δ ${num(rs[i].delta_t_c, 1)} °C`,
      rows: () => [
        { label: 'Hot side', dot: 'var(--hot)', value: `${num(L?.t_hot_c, 1)} °C` },
        { label: 'Cold side', dot: 'var(--cold)', value: `${num(L?.t_cold_c, 1)} °C` },
      ],
    },
  ];

  // ---- phone tab ----
  const pct = L ? (L.energy_wh / PHONE_WH) * 100 : NaN;
  const phoneRows = [
    { label: 'Run time', value: S ? duration(Date.parse(S.latest_ts) - Date.parse(S.first_ts)) : '—' },
    { label: 'Charge stored', value: `${num(L?.charge_mah, 0)} mAh` },
    { label: 'Average power', value: `${num(S?.avg_power_w, 3)} W` },
  ];

  return (
    <div className="jl" data-theme={theme}>
      <div className="jl-wrap">
        <header className="jl-header">
          <div className="jl-brand">
            <img className="jl-logo" src={logo} alt="Jolteon logo" />
            <div className="jl-header-text">
              <h1>Jolteon monitor</h1>
              <div className="jl-status">
                <Bolt size={22} off={status !== 'live'} />
                <strong>{statusText}</strong>
                {L && <span>{L.phase}</span>}
                {L && <span>{clock(L.ts)}</span>}
              </div>
            </div>
          </div>
          <div className="jl-header-right">
            <img className="jl-trio" src={trio} alt="Flareon, Jolteon and Glaceon sitting together" />
            <button
              type="button"
              className="jl-iconbtn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                </svg>
              )}
            </button>
          </div>
        </header>

        <Segmented
          label="View"
          className="jl-seg-view"
          value={view}
          onChange={setView}
          options={[
            { key: 'charts', label: 'Charts' },
            { key: 'phone', label: 'Phone' },
          ]}
        />

        {view === 'phone' && (
          <section className="jl-card jl-phone" aria-label="Phone charge">
            <Ring pct={pct} />
            <div className="jl-phone-body">
              <div>
                <h2 className="jl-phone-title">Phone charge</h2>
                <div className="jl-phone-sub">
                  {num(L?.energy_wh, 2)} Wh stored of {PHONE_WH.toFixed(1)} Wh
                </div>
              </div>
              <div className="jl-rows jl-rows-lg">
                {phoneRows.map((r) => (
                  <div className="jl-row" key={r.label}>
                    <span className="jl-row-label">{r.label}</span>
                    <span className="jl-row-value jl-row-value-lg">{r.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {view === 'charts' && (
          <>
            <div className="jl-grid">
              {cards.map(({ key, ...c }) => (
                <ChartCard key={key} {...c} />
              ))}
            </div>

            <section className="jl-card jl-raw" aria-label="Raw readings">
              <div className="jl-raw-head">
                <div>
                  <h2 className="jl-card-title">Raw readings</h2>
                  <p>The newest packets from the ESP32, exactly as stored.</p>
                </div>
                <button
                  type="button"
                  className="jl-btn"
                  aria-expanded={rawOpen}
                  onClick={() => setRawOpen((o) => !o)}
                >
                  {rawOpen ? 'Hide readings' : 'Show readings'}
                </button>
              </div>
              {rawOpen && (
                <div className="jl-table-wrap">
                  <div className="jl-table">
                    <div className="jl-tr jl-th">
                      <span>time</span>
                      <span>t_hot_c</span>
                      <span>t_cold_c</span>
                      <span>delta_t_c</span>
                      <span>gen_w</span>
                      <span>batt_v</span>
                      <span>batt_ma</span>
                    </div>
                    {recent.map((r) => (
                      <div className="jl-tr" key={r.seq}>
                        <span>{clock(r.ts)}</span>
                        <span>{num(r.t_hot_c, 2)}</span>
                        <span>{num(r.t_cold_c, 2)}</span>
                        <span>{num(r.delta_t_c, 2)}</span>
                        <span>{num(r.gen_w, 3)}</span>
                        <span>{num(r.batt_v, 3)}</span>
                        <span>{signed(r.batt_ma, 1)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <footer className="jl-foot">
              Each chart zooms in on the data you are viewing so small changes show. The numbers are raw readings.
              Hover a chart for the exact value.
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
