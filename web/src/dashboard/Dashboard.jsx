import { useEffect, useMemo, useState } from 'react';
import Chart from './Chart';
import { PERIOD_MS, useDashboardData, useReadings, WINDOWS } from './useDashboardData';
import logo from './assets/jolteon-logo.png';
import trio from './assets/eeveelutions.png';
import './dashboard.css';

// Approximate phone battery energy. Check against the exact spec you want to quote.
const PHONE_WH = 13.9;

// Themes only change surface colours (see dashboard.css). Data colours stay put.
const THEMES = [
  { key: 'jolteon', label: 'Jolteon', swatch: '#f2b52e', kana: 'サンダース' },
  { key: 'flareon', label: 'Flareon', swatch: '#f28c28', kana: 'ブースター' },
  { key: 'glaceon', label: 'Glaceon', swatch: '#35c4e8', kana: 'グレイシア' },
  { key: 'light', label: 'Light', swatch: '#efe3c2', kana: 'サンダース' },
];
const THEME_KEYS = THEMES.map((t) => t.key);

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
  const [theme, setThemeState] = useState(() => {
    try {
      const saved = localStorage.getItem('jolteon-theme');
      if (THEME_KEYS.includes(saved)) return saved;
      if (saved === 'dark') return 'jolteon'; // value saved by the earlier version
    } catch {
      /* storage blocked, fall through */
    }
    return 'jolteon';
  });
  const setTheme = (key) => {
    setThemeState(key);
    try {
      localStorage.setItem('jolteon-theme', key);
    } catch {
      /* ignore */
    }
  };
  return [theme, setTheme];
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

// Bolt with three little stars. The stars twinkle each time the parent swaps
// its jl-spA / jl-spB class (once per new reading).
function BoltWithSparkles({ off }) {
  const star = 'M12 0C13 8 16 11 24 12 16 13 13 16 12 24 11 16 8 13 0 12 8 11 11 8 12 0Z';
  return (
    <span className="jl-bolt-wrap">
      <Bolt size={22} off={off} />
      {['jl-sp1', 'jl-sp2', 'jl-sp3'].map((c) => (
        <svg key={c} className={`jl-sp ${c}`} viewBox="0 0 24 24" aria-hidden="true">
          <path d={star} />
        </svg>
      ))}
    </span>
  );
}

function ThemeMenu({ theme, onChange }) {
  const [open, setOpen] = useState(false);
  const current = THEMES.find((t) => t.key === theme) || THEMES[0];

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="jl-theme">
      <button
        type="button"
        className="jl-theme-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Theme"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="jl-swatch" style={{ background: current.swatch }} />
        <span>{current.label}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div className="jl-theme-scrim" onClick={() => setOpen(false)} />
          <div className="jl-theme-menu" role="listbox" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.key}
                type="button"
                role="option"
                aria-selected={t.key === theme}
                className="jl-theme-item"
                onClick={() => {
                  onChange(t.key);
                  setOpen(false);
                }}
              >
                <span className="jl-swatch" style={{ background: t.swatch }} />
                <span>{t.label}</span>
                {t.key === theme && (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
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

// Every card has the same label strip at the top.
function Card({ title, titleClass = 'jl-card-title', className = '', label, children }) {
  return (
    <section className={`jl-card jl-grain ${className}`} aria-label={label || title}>
      <div className="jl-strip">
        <div className="jl-strip-in">
          <h2 className={titleClass}>{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

function Ring({ pct }) {
  const R = 76;
  const C = 2 * Math.PI * R;
  const shown = Math.max(0, Math.min(100, pct || 0));
  return (
    <div className="jl-ring">
      <svg viewBox="0 0 220 220" aria-hidden="true">
        <circle cx="110" cy="110" r="104" className="jl-ring-ticks" />
        <circle cx="110" cy="110" r={R} className="jl-ring-edge" />
        <circle cx="110" cy="110" r={R} className="jl-ring-track" />
        <circle
          cx="110"
          cy="110"
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
    <Card title={title}>
      <div className="jl-card-body">
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
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const [theme, setTheme] = useTheme();
  const [view, setView] = useState('charts'); // 'charts' | 'phone'
  const [rawOpen, setRawOpen] = useState(false);
  const now = useNow(5000);

  const { latest, summary, recent } = useDashboardData();
  const L = latest.data; // newest reading, or null
  const S = summary.data;
  const kana = (THEMES.find((t) => t.key === theme) || THEMES[0]).kana;

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
    // Three missed packets. Derived from PERIOD_MS rather than hardcoded, so
    // changing the write cadence keeps this in step: one late reading is
    // normal, three in a row means the bridge really has stopped.
  } else if (now - Date.parse(L.ts) > 3 * PERIOD_MS) {
    status = 'off';
    statusText = 'No new data';
  }
  // Swapping A/B on every new reading restarts the sparkle animation.
  const sparkClass = status !== 'live' ? 'jl-sp-off' : (L?.seq ?? 0) % 2 ? 'jl-spA' : 'jl-spB';

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
          <div className="jl-hbox jl-hbox-main jl-grain">
            <div className="jl-hbox-in">
              <img className="jl-logo" src={logo} alt="Jolteon logo" />
              <div className="jl-header-text">
                <h1>Jolteon monitor</h1>
                <div className="jl-subrow">
                  <div className={`jl-status ${sparkClass}`}>
                    <BoltWithSparkles off={status !== 'live'} />
                    <strong>{statusText}</strong>
                    {L && <span>{L.phase}</span>}
                    {L && <span>{clock(L.ts)}</span>}
                  </div>
                  <span className="jl-kana" aria-hidden="true">
                    {kana}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="jl-hbox jl-hbox-side jl-grain">
            <div className="jl-hbox-in">
              <img className="jl-trio" src={trio} alt="Flareon, Jolteon and Glaceon sitting together" />
              <ThemeMenu theme={theme} onChange={setTheme} />
            </div>
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
          <Card title="Phone charge" titleClass="jl-phone-title">
            <div className="jl-phone-body-wrap">
              <Ring pct={pct} />
              <div className="jl-phone-body">
                <div className="jl-phone-sub">
                  {num(L?.energy_wh, 2)} Wh stored of {PHONE_WH.toFixed(1)} Wh
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
            </div>
          </Card>
        )}

        {view === 'charts' && (
          <>
            <div className="jl-grid">
              {cards.map(({ key, ...c }) => (
                <ChartCard key={key} {...c} />
              ))}
            </div>

            <Card title="Raw readings">
              <div className="jl-raw-body">
                <div className="jl-raw-head">
                  <p>The newest packets from the ESP32, exactly as stored.</p>
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
              </div>
            </Card>

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
