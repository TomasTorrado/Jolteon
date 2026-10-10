import { useEffect, useState } from 'react';
import { getLatest, getReadings, getSummary } from './api';

// The ESP32 sends one packet every ~10 s and the bridge writes one row per
// packet, so there is nothing new to fetch more often than that.
export const PERIOD_MS = 10000;

// A plain 10 s timer is NOT enough on its own: nothing says where in the
// producer's 10 s cycle our request lands, and if it settles just *before*
// each write it shows 10 s old data forever. So the live polls lock onto the
// data instead of the clock -- look every RETRY_MS until we catch the moment a
// new row appears, then sleep until just before the next one is due and look
// again. Steady state is 2 requests per row, newest row well under a second
// old; a 2 s timer costs 5 requests per row for the same freshness.
const LEAD_MS = 1000; // wake this early so a little drift can't overshoot
const RETRY_MS = 1000; // how often to look while hunting for the next row
const MIN_GAP_MS = 250; // never hammer, whatever the arithmetic says

// How many fruitless looks before deciding the writer has stopped. Derived
// from the period with real headroom, not a flat number: if the firmware's
// REPORT_EVERY is raised, a flat budget would run out every single row and the
// lock would never catch an edge again.
const maxRetries = (intervalMs) => Math.ceil(intervalMs / RETRY_MS) + 8;

// Identity of a reading. `seq` alone is not enough: it restarts at 0 when the
// board is power-cycled, so a reboot would look like old data.
const rowKey = (r) => (r ? `${r.seq}@${r.ts}` : null);
const lastRowKey = (rows) => (rows && rows.length ? rowKey(rows[rows.length - 1]) : null);
const summaryKey = (s) => (s && s.latest_ts ? s.latest_ts : null);

// Each tab asks for a different slice of history.
//  live: last 2 min, locked to the write cadence (see above)
//  12h / 24h: downsampled by the API (max_points), plain 10 s timer -- these
//  show accumulated history for the judges, so a point arriving a few seconds
//  late costs nothing and one request per period is cheaper.
export const WINDOWS = {
  live: { label: 'Live', ms: 2 * 60e3, max: 120, every: PERIOD_MS, lock: true },
  '12h': { label: '12h', ms: 12 * 3600e3, max: 300, every: PERIOD_MS },
  '24h': { label: '24h', ms: 24 * 3600e3, max: 300, every: PERIOD_MS },
};

// Calls fn() now, then again after the previous call finishes (never
// overlapping). Keeps the last good data if a request fails.
//
// Pass `keyOf` to phase-lock to the data: it returns the identity of the
// newest payload, and the next call is timed from when that identity changed.
// Without it this is a plain `intervalMs` timer.
function usePoll(fn, intervalMs, deps, keyOf) {
  const [state, setState] = useState({ data: null, error: null, loaded: false });

  useEffect(() => {
    let alive = true;
    let timer;
    let ctrl;
    let lastKey; // identity of the newest payload we have already seen
    let hunting = false; // true while looking for the next row at RETRY_MS
    let retries = 0; // consecutive looks that found nothing new
    let busy = false; // a request is in flight right now
    const retryBudget = maxRetries(intervalMs);
    setState({ data: null, error: null, loaded: false });

    const schedule = (ms) => {
      if (alive) timer = setTimeout(tick, Math.max(ms, MIN_GAP_MS));
    };
    const tick = async () => {
      if (document.hidden) {
        hunting = false;
        return schedule(intervalMs);
      }
      ctrl = new AbortController();
      const sentAt = Date.now();
      busy = true;
      try {
        const data = await fn(ctrl.signal);
        if (!alive) return;
        setState({ data, error: null, loaded: true });
        if (!keyOf) return schedule(intervalMs);

        // Time the next wake from when this request was SENT, so a slow
        // response can't walk the lock forward a little every cycle until it
        // overshoots the row and has to hunt all over again.
        const after = (ms) => schedule(ms - (Date.now() - sentAt));
        // Look again shortly -- unless the writer has clearly stopped, in
        // which case fall back to the plain timer and STAY there (don't reset
        // `retries`) until something new actually shows up.
        const hunt = () => {
          if (retries >= retryBudget) {
            hunting = false;
            return after(intervalMs);
          }
          retries += 1;
          hunting = true;
          return after(RETRY_MS);
        };

        const key = keyOf(data);
        // Nothing stored yet (empty table) -- no cadence to lock onto.
        if (key == null) {
          hunting = false;
          return after(intervalMs);
        }
        // Same row as last time: the next one has not landed yet.
        if (key === lastKey) return hunt();
        // A new row. If we were hunting, we know within RETRY_MS when it
        // appeared and can sleep until just before the next one is due.
        // Otherwise its phase is unknown (first load, back from a hidden tab,
        // writer restarted), so hunt for the next edge instead of guessing.
        const caught = hunting;
        lastKey = key;
        retries = 0;
        if (!caught) return hunt();
        hunting = false;
        return after(intervalMs - LEAD_MS);
      } catch (error) {
        if (alive && error.name !== 'AbortError') {
          setState((s) => ({ ...s, error }));
        }
      } finally {
        busy = false;
      }
      hunting = false;
      schedule(intervalMs);
    };

    // A hidden tab stops fetching, and the browser throttles its timers hard
    // (minutes, once hidden a while). Without this the dashboard would sit on
    // the pre-hide reading -- showing "No new data" -- for a whole period or
    // more after being brought back. So fetch immediately on re-show, and drop
    // the lock: we have no idea where the writer's cycle is any more.
    const onVisible = () => {
      if (!alive || document.hidden || busy) return;
      clearTimeout(timer);
      hunting = false;
      retries = 0;
      tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    tick();

    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
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
  return usePoll(
    (signal) => getReadings(Date.now() - w.ms, w.max, signal),
    w.every,
    [win],
    w.lock ? lastRowKey : undefined,
  );
}

export function useDashboardData() {
  const latest = usePoll(getLatest, PERIOD_MS, [], rowKey);
  const summary = usePoll(getSummary, PERIOD_MS, [], summaryKey);

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
