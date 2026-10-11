// Hot-plate overheat thresholds, in °C. The alarm clears a little below where
// it trips so a plate sitting right at the limit can't flap it on and off with
// every 10 s reading.
export const HOT_ALARM_C = 110;
export const HOT_CLEAR_C = 108;

// Next on/off state given the newest hot-side reading. A missing reading (the
// DS18B20 dropped out and the firmware sent null) is not proof of anything, so
// it leaves the state as it was.
export function overheatOn(on, tHot) {
  if (!Number.isFinite(tHot)) return on;
  if (tHot >= HOT_ALARM_C) return true;
  if (tHot < HOT_CLEAR_C) return false;
  return on;
}
