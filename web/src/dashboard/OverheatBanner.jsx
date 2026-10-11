import { HOT_ALARM_C, HOT_CLEAR_C } from './overheat';
import { SNOOZE_MS } from './useOverheatAlarm';
import './alarm.css';

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });

export default function OverheatBanner({ alarm, soundReady, snoozeLeft, enableSound, snooze }) {
  let button;
  if (!soundReady) {
    button = (
      <button type="button" className="jl-alarm-btn" onClick={enableSound}>
        Enable alarm sound
      </button>
    );
  } else if (snoozeLeft > 0) {
    button = (
      <button type="button" className="jl-alarm-btn" disabled>
        Silenced · {snoozeLeft} s
      </button>
    );
  } else {
    button = (
      <button type="button" className="jl-alarm-btn" onClick={snooze}>
        Silence {SNOOZE_MS / 1000} s
      </button>
    );
  }

  return (
    <div className="jl-alarm" role="alert">
      <div className="jl-alarm-in">
        <div className="jl-alarm-text">
          <h2 className="jl-alarm-title">Hot side overheat</h2>
          <p>
            {alarm.probeLost ? 'Last hot plate reading' : 'Hot plate at'}{' '}
            <strong>{alarm.temp.toFixed(1)} °C</strong>, limit {HOT_ALARM_C} °C. Peak{' '}
            {alarm.peak.toFixed(1)} °C, first seen {time(alarm.since)}.
          </p>
          <p>
            {alarm.probeLost
              ? `Hot probe stopped reading at ${time(alarm.ts)}. Check it before assuming the plate has cooled.`
              : `Cool the hot plate now. This clears once it reads below ${HOT_CLEAR_C} °C.`}
          </p>
        </div>
        {button}
      </div>
    </div>
  );
}
