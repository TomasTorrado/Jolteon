// Jolteon ESP32 firmware for the real run
// Based on firmware/test/complete_hardware_test.ino: same pins, addresses, libraries and sensor reading.
// Sections marked "// ADDED:" are new for the real run; everything else is the test sketch's code.
//
// INA219 #1 (TEG side)      bus 1: SDA -> GPIO 21, SCL -> GPIO 22
// INA219 #2 (battery side)  bus 2: SDA -> GPIO 25, SCL -> GPIO 26
// Both boards at 0x40 (A0 open). VCC -> 3V3, GND -> common ground.
//
// DS18B20 hot plate   DAT -> GPIO 4,  4.7k pull-up to 3V3
// DS18B20 cold plate  DAT -> GPIO 5,  4.7k pull-up to 3V3
// Probe VCC (red) -> 3V3, GND (black) -> common ground.
//
// Power path:
//   TEG array + -> #1 VIN+ ; #1 VIN- -> 1N5819 anode
//   Harvest:  1N5819 cathode (band) -> switch -> #2 VIN+
//   USB out:  boost IN+             -> switch -> #2 VIN+
//   #2 VIN- -> battery + ; battery -, TEG array -, boost IN- -> common ground
//
// Battery current from INA219 #2: positive = charging from the TEGs, negative = feeding the USB boost.
//
// ADDED: Output for the bridge (bridge/contract.py), 115200 baud:
//   one JSON line every 10 s:
//   {"seq":..,"up":..,"ph":"chg"|"dis","th":..,"tc":..,"gv":..,"gi":..,"bv":..,"bi":..,"mah":..,"wh":..}
//   every other line starts with "#" (the bridge treats those as log messages).
// ADDED: Serial commands (type in the Serial Monitor, with the bridge stopped):
//   RESET  -> zero seq and the totals, and save
//   STATUS -> print the current seq and totals
//
// Libraries: Adafruit INA219, OneWire, DallasTemperature. Preferences comes with the ESP32 core.

#include <Wire.h>
#include <Adafruit_INA219.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>  // ADDED: flash storage for seq and totals

const int BUS1_SDA = 21;
const int BUS1_SCL = 22;
const int BUS2_SDA = 25;
const int BUS2_SCL = 26;
const int HOT_PROBE_PIN = 4;
const int COLD_PROBE_PIN = 5;

const unsigned long SAMPLE_INTERVAL_MS = 1000;
const float CHARGE_THRESHOLD_MA = 2.0;
const float USB_THRESHOLD_MA = 15.0;
const float BACKFLOW_THRESHOLD_MA = 2.0;
const float LOW_BATTERY_V = 3.0;
const float FULL_BATTERY_V = 4.3;
const float PROBE_SWAP_MARGIN_C = 2.0;

// ADDED: real-run settings
const uint32_t REPORT_EVERY = 10;   // print a JSON line every 10 samples (10 s)
const uint32_t SAVE_EVERY = 6;      // save seq and totals to flash every 6 lines (~60 s)
const float DISCHARGE_MA = -5.0;    // battery current below this -> "ph":"dis"
// INA219 #2's VIN+/VIN- are wired reversed on this build, so its raw current reads negative
// while charging. -1 flips it back to positive = charging. Set to 1.0 if the wires are swapped.
const float BATT_CURRENT_SIGN = -1.0;

Adafruit_INA219 inaTeg(0x40);
Adafruit_INA219 inaBatt(0x40);

OneWire wireHot(HOT_PROBE_PIN);
OneWire wireCold(COLD_PROBE_PIN);
DallasTemperature hotProbe(&wireHot);
DallasTemperature coldProbe(&wireCold);

Preferences prefs;  // ADDED

enum class Mode { Idle, Charging, UsbOut };

struct Reading {
  float busV;
  float shuntmV;
  float currentmA;
};

unsigned long lastSampleMs = 0;
unsigned long modeSinceMs = 0;
Mode mode = Mode::Idle;
bool hotPresent = false;
bool coldPresent = false;

float sessionmWh = 0;
float sessionmAh = 0;

// ADDED: persistent state (survives resets via flash)
uint32_t seq = 0;          // packet counter: +1 per JSON line, never reused
double chargeMah = 0.0;    // running total charge into the battery (net: discharge subtracts)
double energyWh = 0.0;     // running total energy into the battery (net)

// ADDED: latest sample, printed in the next JSON line
float lastHotC = DEVICE_DISCONNECTED_C, lastColdC = DEVICE_DISCONNECTED_C;
float lastTegV = 0, lastTegmA = 0, lastBattV = 0, lastBattmA = 0;
uint32_t samplesSinceReport = 0;
uint32_t linesSinceSave = 0;
String cmdBuffer;

const char *modeName(Mode m) {
  switch (m) {
    case Mode::Idle: return "IDLE";
    case Mode::Charging: return "CHARGING";
    case Mode::UsbOut: return "USB OUT";
  }
  return "?";
}

Reading readSensor(Adafruit_INA219 &ina) {
  return {ina.getBusVoltage_V(), ina.getShuntVoltage_mV(), ina.getCurrent_mA()};
}

// -127 means the probe did not answer; 85 is the power-on value before a real conversion.
bool validTemp(float c) {
  return c != DEVICE_DISCONNECTED_C && c != 85.0;
}

bool checkProbe(DallasTemperature &probe, const char *name, int pin) {
  probe.begin();
  int count = probe.getDeviceCount();
  DeviceAddress addr;
  if (count == 0 || !probe.getAddress(addr, 0)) {
    Serial.printf("# [FAIL] %s probe on GPIO %d: not found. Check DAT wire, 4.7k pull-up to 3V3, VCC and GND.\n", name, pin);
    return false;
  }
  Serial.printf("# [ OK ] %s probe on GPIO %d: ", name, pin);
  for (int i = 0; i < 8; i++) Serial.printf("%02X", addr[i]);
  if (count > 1) Serial.printf("  (warning: %d devices on this pin, expected 1)", count);
  Serial.println();
  probe.setResolution(12);
  probe.setWaitForConversion(false);
  probe.requestTemperatures();
  return true;
}

void printSessionEnd(Mode ended, unsigned long now) {
  float seconds = (now - modeSinceMs) / 1000.0;
  switch (ended) {
    case Mode::Charging:
      Serial.printf("# <<< Charging stopped after %.0f s: %.2f mAh, %.2f mWh into battery\n", seconds, sessionmAh, sessionmWh);
      break;
    case Mode::UsbOut:
      Serial.printf("# <<< USB output OFF after %.0f s: %.2f mAh, %.2f mWh delivered\n", seconds, sessionmAh, sessionmWh);
      break;
    case Mode::Idle:
      break;
  }
}

// ADDED: flash (NVS) storage --------------------------------------------------

void loadState() {
  prefs.begin("jolteon", true);  // read-only
  uint32_t savedSeq = prefs.getUInt("seq", 0);
  chargeMah = prefs.getDouble("mah", 0.0);
  energyWh = prefs.getDouble("wh", 0.0);
  prefs.end();
  // Up to SAVE_EVERY lines may have been printed after the last save, so always jump ahead,
  // even from 0 (e.g. a restart right after RESET, before the first save): a seq value is
  // never reused (the bridge would drop it as a duplicate). The cost is a small gap in seq.
  seq = savedSeq + SAVE_EVERY;
}

void saveState() {
  prefs.begin("jolteon", false);  // read-write
  prefs.putUInt("seq", seq);
  prefs.putDouble("mah", chargeMah);
  prefs.putDouble("wh", energyWh);
  prefs.end();
}

void resetState() {
  seq = 0;
  chargeMah = 0.0;
  energyWh = 0.0;
  linesSinceSave = 0;
  saveState();
  Serial.println("# RESET: seq and totals set to zero and saved. Clear the readings table before the real run.");
}

// ADDED: running totals, from the real elapsed time between samples
void integrate(float battV, float battmA, float dtHours) {
  chargeMah += battmA * dtHours;                 // mA * h = mAh
  energyWh += (battV * battmA / 1000.0) * dtHours;  // W * h = Wh
}

// ADDED: one JSON line in the bridge's format; missing probes print null
void printReading() {
  seq++;
  const char *phase = (lastBattmA < DISCHARGE_MA) ? "dis" : "chg";
  char th[12], tc[12];
  if (validTemp(lastHotC)) snprintf(th, sizeof th, "%.2f", lastHotC); else strcpy(th, "null");
  if (validTemp(lastColdC)) snprintf(tc, sizeof tc, "%.2f", lastColdC); else strcpy(tc, "null");

  char line[240];
  snprintf(line, sizeof line,
           "{\"seq\":%lu,\"up\":%lu,\"ph\":\"%s\",\"th\":%s,\"tc\":%s,"
           "\"gv\":%.3f,\"gi\":%.2f,\"bv\":%.3f,\"bi\":%.2f,\"mah\":%.3f,\"wh\":%.5f}",
           (unsigned long)seq, (unsigned long)(millis() / 1000), phase, th, tc,
           lastTegV, lastTegmA, lastBattV, lastBattmA, chargeMah, energyWh);
  Serial.println(line);

  if (++linesSinceSave >= SAVE_EVERY) {
    saveState();
    linesSinceSave = 0;
  }
}

// ADDED: the test sketch's warnings, checked once per JSON line instead of every second
void printWarnings() {
  bool haveDelta = validTemp(lastHotC) && validTemp(lastColdC);
  if (lastTegmA < -BACKFLOW_THRESHOLD_MA) {
    Serial.printf("# !!! INA219 #1 reads %.1f mA (negative = flowing back into the TEGs). Check the diode direction and INA219 #1 VIN+/VIN- order.\n", lastTegmA);
  }
  if (mode == Mode::UsbOut && lastBattV < LOW_BATTERY_V) {
    Serial.println("# !!! Battery below 3.0 V - turn the USB off to protect the cells");
  }
  if (mode == Mode::Charging && lastBattV > FULL_BATTERY_V) {
    Serial.println("# !!! Battery above 4.3 V - pack is full");
  }
  if (haveDelta && lastHotC - lastColdC < -PROBE_SWAP_MARGIN_C) {
    Serial.printf("# !!! Cold plate reads warmer than hot plate - probes may be swapped (GPIO %d = hot, GPIO %d = cold)\n", HOT_PROBE_PIN, COLD_PROBE_PIN);
  }
}

// ADDED: serial commands (RESET, STATUS), one per line
void handleCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      cmdBuffer.trim();
      if (cmdBuffer.equalsIgnoreCase("RESET")) {
        resetState();
      } else if (cmdBuffer.equalsIgnoreCase("STATUS")) {
        Serial.printf("# STATUS seq=%lu mah=%.3f wh=%.5f up=%lu s\n", (unsigned long)seq, chargeMah, energyWh,
                      (unsigned long)(millis() / 1000));
      } else if (cmdBuffer.length() > 0) {
        Serial.printf("# unknown command '%s' (use RESET or STATUS)\n", cmdBuffer.c_str());
      }
      cmdBuffer = "";
    } else if (cmdBuffer.length() < 32) {
      cmdBuffer += c;
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("# === Jolteon firmware ===");

  Wire.begin(BUS1_SDA, BUS1_SCL);
  Wire1.begin(BUS2_SDA, BUS2_SCL);

  bool tegOk = inaTeg.begin(&Wire);
  bool battOk = inaBatt.begin(&Wire1);
  Serial.printf("# [%s] INA219 #1 (TEG side) on GPIO 21/22\n", tegOk ? " OK " : "FAIL");
  Serial.printf("# [%s] INA219 #2 (battery side) on GPIO 25/26\n", battOk ? " OK " : "FAIL");

  hotPresent = checkProbe(hotProbe, "Hot-plate", HOT_PROBE_PIN);
  coldPresent = checkProbe(coldProbe, "Cold-plate", COLD_PROBE_PIN);

  if (!tegOk || !battOk) {
    // ADDED: repeat the error every 10 s (instead of printing it once), so it shows up in the bridge's log
    while (true) {
      Serial.println("# ERROR: both INA219s are required. Check SDA/SCL, VCC and GND, then reset.");
      delay(10000);
    }
  }

  // TEG current stays small; the battery side must also handle the phone's load.
  inaTeg.setCalibration_16V_400mA();
  inaBatt.setCalibration_32V_2A();

  Reading batt = readSensor(inaBatt);
  if (batt.busV < LOW_BATTERY_V) {
    Serial.printf("# [WARN] Battery reads %.2f V. Three NiMH cells should read 3.0-4.2 V: check each cell and its orientation.\n", batt.busV);
  } else {
    Serial.printf("# [ OK ] Battery reads %.2f V\n", batt.busV);
  }

  if (!hotPresent || !coldPresent) {
    Serial.println("# Continuing without the missing probe(s); their readings are sent as null");
  }

  // ADDED: restore seq and totals from flash
  loadState();
  Serial.printf("# boot: resuming at seq=%lu, mah=%.3f, wh=%.5f\n", (unsigned long)seq, chargeMah, energyWh);

  // Let the first temperature conversion finish before the first sample.
  delay(800);
  lastSampleMs = millis();
  modeSinceMs = lastSampleMs;
}

void loop() {
  handleCommands();  // ADDED

  unsigned long now = millis();
  if (now - lastSampleMs < SAMPLE_INTERVAL_MS) return;
  float dtHours = (now - lastSampleMs) / 3600000.0;
  lastSampleMs = now;

  // Read the conversion started on the previous pass, then start the next one.
  float hotC = hotPresent ? hotProbe.getTempCByIndex(0) : DEVICE_DISCONNECTED_C;
  float coldC = coldPresent ? coldProbe.getTempCByIndex(0) : DEVICE_DISCONNECTED_C;
  if (hotPresent) hotProbe.requestTemperatures();
  if (coldPresent) coldProbe.requestTemperatures();

  Reading teg = readSensor(inaTeg);
  Reading batt = readSensor(inaBatt);

  // Bus voltage is measured at VIN-; add the shunt drop to get the VIN+ side.
  float tegV = teg.busV + teg.shuntmV / 1000.0;
  float tegmA = teg.currentmA;

  float battV = batt.busV;
  float battmA = BATT_CURRENT_SIGN * batt.currentmA;
  float battmW = battV * battmA;

  Mode newMode = Mode::Idle;
  if (battmA > CHARGE_THRESHOLD_MA) newMode = Mode::Charging;
  else if (battmA < -USB_THRESHOLD_MA) newMode = Mode::UsbOut;

  if (newMode != mode) {
    printSessionEnd(mode, now);
    if (newMode != Mode::Idle) Serial.printf("# >>> %s started\n", modeName(newMode));
    mode = newMode;
    modeSinceMs = now;
    sessionmWh = 0;
    sessionmAh = 0;
  }

  switch (mode) {
    case Mode::Charging:
      sessionmWh += battmW * dtHours;
      sessionmAh += battmA * dtHours;
      break;
    case Mode::UsbOut:
      sessionmWh += -battmW * dtHours;
      sessionmAh += -battmA * dtHours;
      break;
    case Mode::Idle:
      break;
  }

  // ADDED: running totals every sample, and a JSON line every REPORT_EVERY samples
  integrate(battV, battmA, dtHours);
  lastHotC = hotC;
  lastColdC = coldC;
  lastTegV = tegV;
  lastTegmA = tegmA;
  lastBattV = battV;
  lastBattmA = battmA;
  if (++samplesSinceReport >= REPORT_EVERY) {
    printReading();
    printWarnings();
    samplesSinceReport = 0;
  }
}
