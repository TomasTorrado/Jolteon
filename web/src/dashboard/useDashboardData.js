import { useEffect, useState } from 'react';
import { getLatest, getReadings, getSummary } from './api';

// Each tab asks for a different slice of history.
//  live: last 2 min, every 2 s  -> the line visibly moves
//  12h / 24h: downsampled by the API (max_points), every 10 s
export const WINDOWS = {
  live: { label: 'Live', ms: 2 * 60e3, max: 120, every: 2000 },
  '12h': { label: '12h', ms: 12 * 3600e3, max: 300, every: 10000 },
  '24h': { label: '24h', ms: 24 * 3600e3, max: 300, every: 10000 },
};

// Calls fn() now and then every `intervalMs` after the previous call finishes
// (never overlapping). Keeps the last good data if a request fails.
function usePoll(fn, intervalMs, deps) {
  const [state, setState] = useState({ data: null, error: null, loaded: false });

  useEffect(() => {
    let alive = true;
    let timer;
    let ctrl;
    setState({ data: null, error: null, loaded: false });

    const schedule = () => {
      if (alive) timer = setTimeout(tick, intervalMs);
    };
    const tick = async () => {
      if (document.hidden) return schedule();
      ctrl = new AbortController();
      try {
        const data = await fn(ctrl.signal);
        if (alive) setState({ data, error: null, loaded: true });
      } catch (error) {
        if (alive && error.name !== 'AbortError') {
          setState((s) => ({ ...s, error }));
        }
      }
      schedule();
    };
    tick();

    return () => {
      alive = false;
      clearTimeout(timer);
      if (ctrl) ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

// History for ONE chart card. Each card calls this with its own range,
// so changing the tab on one chart never affects the others.
export function useReadings(win) {
  const w = WINDOWS[win];
  return usePoll((signal) => getReadings(Date.now() - w.ms, w.max, signal), w.every, [win]);
}

export function useDashboardData() {
  const latest = usePoll(getLatest, 2000, []);
  const summary = usePoll(getSummary, 10000, []);

  // Last 6 distinct packets seen by the /latest poll, newest first.
  // These feed the "Raw readings" table so it shows real, unaveraged rows.
  const [recent, setRecent] = useState([]);
  useEffect(() => {
    const r = latest.data;
    if (!r) return;
    setRecent((prev) => (prev[0] && prev[0].seq === r.seq ? prev : [r, ...prev].slice(0, 6)));
  }, [latest.data]);

  return { latest, summary, recent };
}
