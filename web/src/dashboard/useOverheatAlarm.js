import { useEffect, useRef, useState } from 'react';
import { overheatOn } from './overheat';

export const SNOOZE_MS = 60e3;

// Two-tone siren: a square wave flipping between these two pitches.
const SIREN_HI_HZ = 880;
const SIREN_LO_HZ = 660;
const SIREN_STEP_S = 0.4; // how long each tone lasts
const SIREN_GAIN = 0.7;

// The pitch flip is driven by a second, slow square-wave oscillator rather
// than a JS timer, so it keeps time even when a background tab's timers are
// throttled. Returns a function that stops it.
function startSiren(ctx) {
  const out = ctx.createGain();
  out.gain.value = SIREN_GAIN;
  out.connect(ctx.destination);

  const tone = ctx.createOscillator();
  tone.type = 'square';
  tone.frequency.value = (SIREN_HI_HZ + SIREN_LO_HZ) / 2;

  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 1 / (2 * SIREN_STEP_S);
  const depth = ctx.createGain();
  depth.gain.value = (SIREN_HI_HZ - SIREN_LO_HZ) / 2;

  lfo.connect(depth).connect(tone.frequency);
  tone.connect(out);
  tone.start();
  lfo.start();
  return () => {
    tone.stop();
    lfo.stop();
    out.disconnect();
  };
}

// Browsers refuse to play sound until the page has had a click or key press,
// so the context may start suspended. Any interaction anywhere unlocks it.
function useAudioContext() {
  const ctxRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return undefined;
    const ctx = new AC();
    ctxRef.current = ctx;
    const sync = () => setReady(ctx.state === 'running');
    const unlock = () => {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    };
    ctx.addEventListener('statechange', sync);
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    sync();
    return () => {
      // Unhook before closing, or the async 'closed' event lands after
      // StrictMode's second mount and flips `ready` off for the new context.
      ctx.removeEventListener('statechange', sync);
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      ctx.close().catch(() => {});
      ctxRef.current = null;
    };
  }, []);

  const unlock = () => {
    if (ctxRef.current) ctxRef.current.resume().catch(() => {});
  };
  return { ctxRef, ready, unlock };
}

// Watches the newest reading and raises a latched alarm while the hot plate is
// too hot. `alarm` is null when all is well, otherwise
// { temp, peak, since, ts, probeLost } -- `temp` is the last good reading.
export function useOverheatAlarm(reading) {
  const [alarm, setAlarm] = useState(null);
  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const audio = useAudioContext();

  useEffect(() => {
    if (!reading) return;
    const t = reading.t_hot_c;
    const good = Number.isFinite(t);
    setAlarm((a) => {
      if (!overheatOn(a != null, t)) return null;
      if (!a) return { temp: t, peak: t, since: reading.ts, ts: reading.ts, probeLost: false };
      return {
        ...a,
        temp: good ? t : a.temp,
        peak: good ? Math.max(a.peak, t) : a.peak,
        ts: reading.ts,
        probeLost: !good,
      };
    });
  }, [reading]);

  // A cleared alarm forgets its snooze, so the next one is loud straight away.
  const on = alarm != null;
  useEffect(() => {
    if (!on) setSnoozeUntil(0);
  }, [on]);

  useEffect(() => {
    if (!snoozeUntil) return undefined;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= snoozeUntil) setSnoozeUntil(0);
    }, 250);
    return () => clearInterval(t);
  }, [snoozeUntil]);

  const snoozed = snoozeUntil > now;
  const sounding = on && audio.ready && !snoozed;
  useEffect(() => {
    const ctx = audio.ctxRef.current;
    if (!sounding || !ctx) return undefined;
    return startSiren(ctx);
  }, [sounding, audio.ctxRef]);

  const titleTemp = alarm ? Math.round(alarm.temp) : null;
  useEffect(() => {
    if (titleTemp == null) return undefined;
    const prev = document.title;
    document.title = `⚠ OVERHEAT ${titleTemp} °C`;
    return () => {
      document.title = prev;
    };
  }, [titleTemp]);

  const snooze = () => {
    const n = Date.now();
    setNow(n);
    setSnoozeUntil(n + SNOOZE_MS);
  };

  return {
    alarm,
    soundReady: audio.ready,
    snoozeLeft: snoozed ? Math.ceil((snoozeUntil - now) / 1000) : 0,
    enableSound: audio.unlock,
    snooze,
  };
}
